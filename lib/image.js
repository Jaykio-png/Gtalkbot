/** Tải ảnh từ URL hoặc file đã upload (data/uploads) + đọc kích thước (PNG/JPEG/GIF). */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\s+/g, '').replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').replace(/\s+/g, '');
const IMG_BUCKET = (process.env.SUPABASE_BUCKET || 'images').trim();
const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);

// Upload bytes lên Supabase Storage -> trả URL công khai
function supaUpload(fname, buffer, mimeType) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${SUPABASE_URL}/storage/v1/object/${IMG_BUCKET}/${fname}`);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': mimeType, 'x-upsert': 'true', 'Content-Length': buffer.length },
    }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => (res.statusCode < 300 ? resolve() : reject(new Error('Storage lỗi ' + res.statusCode + ': ' + d.slice(0, 150))))); });
    req.on('error', reject);
    req.write(buffer); req.end();
  });
}

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('quá nhiều redirect'));
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return resolve(fetchBuffer(new URL(r.headers.location, url).href, redirects + 1));
      }
      if (r.statusCode !== 200) return reject(new Error('tải ảnh lỗi HTTP ' + r.statusCode));
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: r.headers['content-type'] || '' }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('tải ảnh timeout')));
  });
}

function imageDims(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png' };
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), mime: 'image/gif' };
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xFF) { o++; continue; }
      const m = buf[o + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7), mime: 'image/jpeg' };
      }
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}

async function fetchImage(url) {
  const { buffer, contentType } = await fetchBuffer(url);
  const d = imageDims(buffer);
  if (!d) throw new Error('Không đọc được kích thước ảnh (chỉ hỗ trợ PNG/JPEG/GIF).');
  return {
    buffer, width: d.width, height: d.height,
    mimeType: contentType.startsWith('image/') ? contentType.split(';')[0] : d.mime,
    fileName: (url.split('/').pop() || 'image').split('?')[0] || 'image',
  };
}

/** Đọc ảnh đã upload (ref dạng "local:tên-file"). */
function loadLocalImage(ref) {
  const name = path.basename(ref.replace(/^local:/, ''));
  const buffer = fs.readFileSync(path.join(UPLOAD_DIR, name));
  const d = imageDims(buffer);
  if (!d) throw new Error('File ảnh hỏng hoặc không hỗ trợ.');
  return { buffer, width: d.width, height: d.height, mimeType: d.mime, fileName: name };
}

/** Giải quyết imageUrl: "local:..." -> file đã upload; ngược lại -> tải URL. */
async function resolveImage(ref) {
  if (!ref) return null;
  return ref.startsWith('local:') ? loadLocalImage(ref) : fetchImage(ref);
}

/** Lưu ảnh upload (base64) -> trả về ref + dims.
 *  Supabase: đẩy lên Storage, ref = URL công khai. Local: lưu file, ref = "local:...". */
async function saveUpload(filename, base64) {
  const buffer = Buffer.from(base64 || '', 'base64');
  if (!buffer.length) throw new Error('File rỗng.');
  if (buffer.length > 15 * 1024 * 1024) throw new Error('Ảnh quá lớn (>15MB).');
  const d = imageDims(buffer);
  if (!d) throw new Error('Chỉ hỗ trợ PNG/JPEG/GIF.');
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' }[d.mime] || 'png';
  const safe = String(filename || 'img').replace(/[^a-zA-Z0-9._-]/g, '').slice(-40) || 'img';
  const fname = `${Date.now()}_${safe}`.replace(/\.(png|jpe?g|gif)$/i, '') + '.' + ext;

  if (useSupabase) {
    await supaUpload(fname, buffer, d.mime);
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${IMG_BUCKET}/${fname}`;
    return { ref: publicUrl, width: d.width, height: d.height, bytes: buffer.length };
  }
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), buffer);
  return { ref: 'local:' + fname, width: d.width, height: d.height, bytes: buffer.length };
}

module.exports = { fetchImage, imageDims, resolveImage, loadLocalImage, saveUpload, UPLOAD_DIR };
