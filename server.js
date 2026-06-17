const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const { parseOrg } = require('./lib/match');
const { saveUpload } = require('./lib/image');

const PORT = process.env.PORT || 8090;
const MCP_ENDPOINT = 'https://ws-mcpgateway.ghn.vn/mcp';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

// rút gọn 1 send để trả về cho UI
const slimSend = (s) => {
  const { division, department } = parseOrg(s.employee.org);
  return {
    employee_id: s.employee.employee_id,
    full_name: s.employee.full_name,
    title_name: s.employee.title_name,
    division, department,
    day: s.day,
    campaignName: s.campaignName,
    text: s.text,
    parseMode: s.parseMode,
    imageUrl: s.imageUrl,
  };
};

// ---- Đăng nhập (Basic Auth) — bật khi đặt AUTH_USER + AUTH_PASS ----
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;
function authOK(req) {
  if (!AUTH_USER || !AUTH_PASS) return true; // không bật auth nếu chưa cấu hình
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return u === AUTH_USER && p === AUTH_PASS;
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (!authOK(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Campaign Studio"' });
    return res.end('Cần đăng nhập');
  }

  // ---- CORS preflight ----
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Mcp-Auth, X-Mcp-Session-Id',
    });
    return res.end();
  }

  // ---- MCP proxy (giữ cho tab tra cứu của app Lookup) ----
  if (url === '/mcp-proxy' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
      if (req.headers['x-mcp-auth']) headers['Authorization'] = req.headers['x-mcp-auth'];
      if (req.headers['x-mcp-session-id']) headers['Mcp-Session-Id'] = req.headers['x-mcp-session-id'];
      const u = new URL(MCP_ENDPOINT);
      const pr = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers }, (pres) => {
        const sid = pres.headers['mcp-session-id'];
        res.writeHead(pres.statusCode, { 'Content-Type': pres.headers['content-type'] || 'text/plain', 'Access-Control-Allow-Origin': '*', ...(sid ? { 'X-Mcp-Session-Id': sid } : {}) });
        pres.pipe(res);
      });
      pr.on('error', (e) => sendJSON(res, 502, { error: e.message }));
      pr.write(body); pr.end();
    });
    return;
  }

  // ================= API =================
  try {
    if (url === '/api/campaigns' && req.method === 'GET') return sendJSON(res, 200, await store.getCampaigns());
    if (url === '/api/campaigns' && req.method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body)) return sendJSON(res, 400, { error: 'cần một mảng lộ trình' });
      await store.setCampaigns(body);
      return sendJSON(res, 200, { ok: true, count: body.length });
    }

    if (url === '/api/facets' && req.method === 'GET') {
      const emps = Object.values((await store.getRoster())?.employees || {});
      const titles = new Set(), divisions = new Set(), departments = new Set();
      for (const p of emps) {
        if (p.title_name) titles.add(p.title_name);
        const { division, department } = parseOrg(p.org);
        if (division) divisions.add(division);
        if (department) departments.add(department);
      }
      const sortVi = (a, b) => a.localeCompare(b, 'vi');
      return sendJSON(res, 200, {
        titles: [...titles].sort(sortVi),
        divisions: [...divisions].sort(sortVi),
        departments: [...departments].sort(sortVi),
      });
    }

    if (url === '/api/status' && req.method === 'GET') {
      const cfg = (await store.getConfig()) || {};
      let roster = {}, supaErr = null;
      try { roster = (await store.getRoster()) || {}; } catch (e) { supaErr = e.message; }
      const emps = Object.values(roster.employees || {});
      return sendJSON(res, 200, {
        build: 'diag1',
        env: cfg.env || 'prod',
        oaId: cfg.oaId || '',
        hasOaToken: !!cfg.oaToken,
        hasMcpKey: !!cfg.mcpApiKey,
        mcpKeyLen: (cfg.mcpApiKey || '').length,
        supabase: store.useSupabase ? (supaErr ? 'LỖI: ' + supaErr : 'OK') : 'file-mode',
        lastMaxId: roster.lastMaxId || null,
        rosterSize: emps.length,
        maxTenureDays: cfg.maxTenureDays || 60,
      });
    }

    if ((url === '/api/preview' || url === '/api/run') && req.method === 'POST') {
      const { run } = require('./runner');
      const dryRun = url === '/api/preview';
      const report = await run({ dryRun, log: (m) => console.log('[run]', m) });
      return sendJSON(res, 200, { ...report, sends: (report.sends || []).map(slimSend) });
    }

    if (url === '/api/upload-image' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await saveUpload(body.filename, body.base64);
      return sendJSON(res, 200, out);
    }

    if ((url === '/api/quick-preview' || url === '/api/quick-send') && req.method === 'POST') {
      const { quickSend } = require('./runner');
      const body = await readBody(req);
      const dryRun = url === '/api/quick-preview';
      const report = await quickSend({ ids: body.ids || [], text: body.text || '', parseMode: body.parseMode || 'PLAIN_TEXT', imageUrl: body.imageUrl || '', dryRun, log: (m) => console.log('[quick]', m) });
      return sendJSON(res, 200, report);
    }
  } catch (e) {
    return sendJSON(res, 500, { error: e.message });
  }

  // ---- Static files ----
  const filePath = path.join(__dirname, url === '/' ? '/index.html' : url);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 GTalk Campaign Studio: http://localhost:${PORT}`);
});
