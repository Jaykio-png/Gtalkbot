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
// Chỉ giữ ký tự ASCII in được (loại whitespace + ký tự ẩn/Unicode lạ khi copy) — khóa/JWT/URL chỉ gồm ASCII
const env = (k) => (process.env[k] || '').replace(/[^\x21-\x7e]/g, '');
const SUPABASE_URL = env('SUPABASE_URL').replace(/\/+$/, '');
const SUPABASE_KEY = env('SUPABASE_KEY');
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
