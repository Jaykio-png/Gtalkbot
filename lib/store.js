/**
 * Lưu trữ: Supabase (khi có env) HOẶC file local data/*.json (mặc định).
 * Tất cả hàm BẤT ĐỒNG BỘ (trả Promise) để dùng chung 2 chế độ.
 *
 * Chế độ Supabase: bật khi có SUPABASE_URL + SUPABASE_KEY.
 *   - campaigns / roster / sent-log lưu ở bảng kv(key text primary key, value jsonb).
 *   - config lấy từ biến môi trường (secret), không lưu DB.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Tự nạp file gtalkbot.env (KEY=value) vào process.env — không cần `source` hay dotenv.
// Tìm theo thứ tự: GTALKBOT_ENV_FILE → ./gtalkbot.env (gốc project) → /etc/gtalkbot.env.
// Biến đã có sẵn trong môi trường thì KHÔNG ghi đè.
(function loadEnvFile() {
  const candidates = [
    process.env.GTALKBOT_ENV_FILE,
    path.join(__dirname, '..', 'gtalkbot.env'),
    '/etc/gtalkbot.env',
  ].filter(Boolean);
  for (const file of candidates) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const key = s.slice(0, eq).trim();
      let val = s.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && val && process.env[key] === undefined) process.env[key] = val;
    }
    break; // dùng file đầu tiên đọc được
  }
})();

// Chỉ giữ ký tự ASCII in được (loại whitespace + ký tự ẩn/Unicode lạ khi copy) — khóa/JWT/URL chỉ gồm ASCII
const clean = (s) => String(s || '').replace(/[^\x21-\x7e]/g, '');
// Đọc config.json để lấy supabase fallback (khỏi phải set biến môi trường khi chạy local)
let _cfgFile = {};
try { _cfgFile = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')); } catch { /* */ }
// Ưu tiên biến môi trường (deploy), nếu không có thì lấy từ config.json (local)
const SUPABASE_URL = (clean(process.env.SUPABASE_URL) || clean(_cfgFile.supabaseUrl)).replace(/\/+$/, '');
const SUPABASE_KEY = clean(process.env.SUPABASE_KEY) || clean(_cfgFile.supabaseKey);
const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);

/* ---------- file mode ---------- */
function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function fileRead(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch { return fallback; } }
function fileWrite(name, obj) { ensureDir(); fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(obj, null, 2), 'utf8'); }

/* ---------- supabase REST (kv) ---------- */
function supaReq(method, pathQuery, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL + pathQuery);
    const payload = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: {
        apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json',
        ...extraHeaders, ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch { /* */ } resolve({ status: res.statusCode, json: j, raw: d }); }); });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('supabase timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}
async function kvGet(key, fallback) {
  const r = await supaReq('GET', `/rest/v1/kv?key=eq.${encodeURIComponent(key)}&select=value`);
  const row = Array.isArray(r.json) && r.json[0];
  return row ? row.value : fallback;
}
async function kvSet(key, value) {
  const r = await supaReq('POST', '/rest/v1/kv?on_conflict=key', [{ key, value }], { Prefer: 'resolution=merge-duplicates,return=minimal' });
  if (r.status >= 300) throw new Error('Supabase ghi lỗi (' + r.status + '): ' + (r.raw || '').slice(0, 200));
}

/* ---------- API thống nhất ---------- */
async function getKV(key, file, fallback) { return useSupabase ? kvGet(key, fallback) : fileRead(file, fallback); }
async function setKV(key, file, value) { return useSupabase ? kvSet(key, value) : fileWrite(file, value); }

// Đọc + làm sạch 1 biến môi trường (loại whitespace/ký tự ẩn khi copy token)
function env(name) { return clean(process.env[name]); }

async function getConfig() {
  // Deploy: lấy secret từ env. Local: từ data/config.json
  if (process.env.OA_TOKEN) {
    return {
      env: (process.env.GTALK_ENV || 'prod').trim(),
      oaId: env('OA_ID'),
      oaToken: env('OA_TOKEN'),
      mcpApiKey: env('MCP_API_KEY'),
      frontierStartGuess: Number(process.env.FRONTIER_START_GUESS || 3170000),
      backfillIdSpan: Number(process.env.BACKFILL_ID_SPAN || 10000),
      maxTenureDays: Number(process.env.MAX_TENURE_DAYS || 60),
      concurrency: Number(process.env.CONCURRENCY || 8),
    };
  }
  return fileRead('config.json', null);
}

module.exports = {
  DATA_DIR, useSupabase,
  getConfig,
  getCampaigns: () => getKV('campaigns', 'campaigns.json', []),
  setCampaigns: (c) => setKV('campaigns', 'campaigns.json', c),
  getRoster: () => getKV('roster', 'roster.json', {}),
  setRoster: (r) => setKV('roster', 'roster.json', r),
  getSentLog: () => getKV('sent-log', 'sent-log.json', {}),
  setSentLog: (s) => setKV('sent-log', 'sent-log.json', s),
};
