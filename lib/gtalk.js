/**
 * GTalk client (server-side) — bắn tin một chiều.
 *   create-server-direct-channel (identityId = employee_id) -> channelId
 *   send-message (text)
 * Đã kiểm chứng thật trên Production.
 */
const https = require('https');

const BASE = {
  prod: 'https://mbff.ghn.vn',
  test: 'https://test-api.mbff.ghn.tech',
};

// PUT nhị phân lên URL bất kỳ (presigned S3) — không cần auth header
function putBinary(fullUrl, buffer, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(fullUrl);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'PUT', headers: { 'Content-Type': contentType, 'Content-Length': buffer.length } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, raw: d })); }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('S3 PUT timeout')));
    req.write(buffer); req.end();
  });
}

function postJSON(baseUrl, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = JSON.stringify(bodyObj);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* ignore */ }
          resolve({ status: res.statusCode, json, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('GTalk request timeout')));
    req.write(payload);
    req.end();
  });
}

class GtalkClient {
  /** @param {{oaId:string, oaToken:string, env?:'prod'|'test'}} cfg */
  constructor({ oaId, oaToken, env = 'prod' }) {
    this.oaId = oaId;
    this.oaToken = oaToken;
    this.base = BASE[env] || BASE.prod;
  }

  /** Tạo (hoặc lấy) kênh riêng OA <-> nhân viên. identityId = employee_id. */
  async createDirectChannel(employeeId) {
    const r = await postJSON(this.base, '/api/gtalk/create-server-direct-channel', {
      oaId: this.oaId,
      oaToken: this.oaToken,
      identity: { identityChannel: 1, identityId: String(employeeId) },
    });
    if (r.json?.errorCode === 'success' && r.json?.data?.channelId) {
      return r.json.data.channelId;
    }
    const msg = r.json?.error?.errorMessage || r.json?.errorCode || r.raw?.slice(0, 200) || 'unknown';
    throw new Error(`create-channel failed (emp ${employeeId}): ${msg}`);
  }

  /** Quy trình upload ảnh 3 bước → trả về fileId. */
  async uploadImage(channelId, { buffer, fileName, mimeType, width, height, thumbBuffer }) {
    const init = await postJSON(this.base, '/api/gtalk/initiate-upload', {
      ChannelId: String(channelId), FileName: fileName, FileSize: String(buffer.length),
      MimeType: mimeType, Metadata: JSON.stringify({ width, height }), oaToken: this.oaToken,
    });
    if (init.json?.errorCode !== 'success' || !init.json?.data?.UploadId) {
      throw new Error('initiate-upload failed: ' + (init.json?.error?.errorMessage || init.raw?.slice(0, 200)));
    }
    const { PresignedURL, PresignedThumbURL, UploadId } = init.json.data;
    const r1 = await putBinary(PresignedURL, buffer, mimeType);
    if (r1.status !== 200) throw new Error('PUT original failed: ' + r1.status + ' ' + r1.raw?.slice(0, 150));
    const r2 = await putBinary(PresignedThumbURL, thumbBuffer || buffer, mimeType);
    if (r2.status !== 200) throw new Error('PUT thumb failed: ' + r2.status + ' ' + r2.raw?.slice(0, 150));
    const done = await postJSON(this.base, '/api/gtalk/complete-upload', { oaToken: this.oaToken, UploadId });
    if (done.json?.errorCode !== 'success' || !done.json?.data?.Id) {
      throw new Error('complete-upload failed: ' + (done.json?.error?.errorMessage || done.raw?.slice(0, 200)));
    }
    return done.json.data.Id;
  }

  /** Bắn 1 tin ẢNH (có caption) vào channelId. parseMode để caption render định dạng. */
  async sendPhoto(channelId, { fileId, width, height, caption = '', parseMode = 'PLAIN_TEXT' }) {
    const clientMsgId = String(Date.now()) + String(Math.floor(Math.random() * 1000));
    const r = await postJSON(this.base, '/api/gtalk/send-message', {
      channelId: String(channelId), clientMsgId,
      content: { attachment: { caption, items: [{ image: { fileId: String(fileId), width, height } }], parseMode }, parseMode },
      oaToken: this.oaToken,
    });
    if (r.json?.errorCode === 'success') return r.json.data?.globalMsgId || true;
    throw new Error('send photo failed: ' + (r.json?.error?.errorMessage || JSON.stringify(r.json?.error) || r.raw?.slice(0, 200)));
  }

  /** Bắn 1 tin text vào channelId. */
  async sendText(channelId, text, parseMode = 'PLAIN_TEXT') {
    const clientMsgId = String(Date.now()) + String(Math.floor(Math.random() * 1000));
    const payload = {
      channelId: String(channelId),
      clientMsgId,
      content: { text, parseMode },
      oaToken: this.oaToken,
    };
    console.log(`[GTalk] parseMode=${parseMode} len=${text.length}`);
    const r = await postJSON(this.base, '/api/gtalk/send-message', payload);
    if (r.json?.errorCode === 'success') return r.json.data?.globalMsgId || true;
    const msg = r.json?.error?.errorMessage || JSON.stringify(r.json?.error || r.json?.errorCode) || r.raw?.slice(0, 200);
    throw new Error(`send-message failed (channel ${channelId}): ${msg}`);
  }

  /** Tiện ích: gửi cho 1 nhân viên theo employee_id (tạo kênh + bắn text). */
  async sendToEmployee(employeeId, text, parseMode = 'PLAIN_TEXT') {
    const channelId = await this.createDirectChannel(employeeId);
    const globalMsgId = await this.sendText(channelId, text, parseMode);
    return { channelId, globalMsgId };
  }

  /** Gửi ẢNH (đã có buffer+dims) cho 1 nhân viên; caption = text (có parseMode). */
  async sendImageToEmployee(employeeId, img, caption = '', parseMode = 'PLAIN_TEXT') {
    const channelId = await this.createDirectChannel(employeeId);
    const fileId = await this.uploadImage(channelId, img);
    const globalMsgId = await this.sendPhoto(channelId, { fileId, width: img.width, height: img.height, caption, parseMode });
    return { channelId, globalMsgId, fileId };
  }

  /** Gửi ẢNH + CHỮ ĐỊNH DẠNG = 2 tin (ảnh trước, chữ sau) — vì caption ảnh không render định dạng. */
  async sendImageAndText(employeeId, img, text, parseMode = 'PLAIN_TEXT') {
    const channelId = await this.createDirectChannel(employeeId);
    const fileId = await this.uploadImage(channelId, img);
    await this.sendPhoto(channelId, { fileId, width: img.width, height: img.height, caption: '' });
    const globalMsgId = await this.sendText(channelId, text, parseMode);
    return { channelId, globalMsgId, fileId };
  }
}

module.exports = { GtalkClient };
