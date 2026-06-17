/**
 * Bộ chạy: đồng bộ roster (dò biên + quét ID mới) -> khớp lộ trình -> (xem trước | gửi).
 * Dùng cho:
 *   - server.js (endpoint /api/preview, /api/run)
 *   - cron hằng ngày:  node runner.js --run
 *   - xem trước CLI:   node runner.js
 */
const { McpClient } = require('./lib/mcp');
const { GtalkClient } = require('./lib/gtalk');
const { computeSends, renderMessage } = require('./lib/match');
const { resolveImage } = require('./lib/image');
const roster = require('./lib/roster');
const store = require('./lib/store');

async function run({ dryRun = true, sync = null, log = () => {}, now = new Date() } = {}) {
  const config = await store.getConfig();
  if (!config) throw new Error('Chưa có cấu hình (env hoặc data/config.json).');
  const campaigns = (await store.getCampaigns()).filter((c) => c.enabled !== false);

  // Chỉ cần quét roster nếu có lộ trình KHÔNG dùng ID cố định (tức nhắm NV mới qua bộ lọc)
  const needsRoster = campaigns.some((c) => !(c.targetIds && c.targetIds.length));
  // sync mặc định: chỉ đồng bộ khi GỬI thật VÀ thực sự cần roster
  if (sync === null) sync = !dryRun && needsRoster;

  let mcp = null;
  let active, lastMaxId;
  if (sync) {
    // Đồng bộ roster (lần đầu backfill, sau đó chỉ quét ID mới)
    mcp = new McpClient(config.mcpApiKey);
    await mcp.connect();
    const { state, active: a } = await roster.sync(mcp, config, log, now);
    active = a; lastMaxId = state.lastMaxId;
  } else {
    // Tức thì: dùng roster đã lưu, không quét MCP
    const r = (await store.getRoster()) || {};
    active = Object.values(r.employees || {});
    lastMaxId = r.lastMaxId || null;
    if (active.length === 0) log('Roster trống — cần backfill (xóa data/roster.json rồi chạy có sync).');
  }

  const report = { lastMaxId, rosterSize: active.length, dryRun, synced: sync, sends: [], sent: [], errors: [] };

  if (campaigns.length === 0) { report.note = 'Chưa có lộ trình nào đang bật.'; return report; }

  // 2) Tra cứu các ID cố định (targetIds) — có thể là người cũ không có trong roster
  const targetIds = [...new Set(campaigns.flatMap((c) => (c.targetIds || []).map(Number)).filter(Number.isFinite))];
  const profilesById = {};
  if (targetIds.length) {
    if (!mcp) { mcp = new McpClient(config.mcpApiKey); await mcp.connect(); }
    log(`Tra cứu ${targetIds.length} ID cố định...`);
    let i = 0;
    const worker = async () => {
      while (i < targetIds.length) {
        const id = targetIds[i++];
        try { const r = await mcp.lookup(id, true); if (r?.found && r.profile) profilesById[r.profile.employee_id] = r.profile; } catch { /* bỏ qua */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, targetIds.length) }, worker));
  }

  // 3) Khớp -> tin cần gửi hôm nay
  const sentLog = await store.getSentLog();
  const sends = computeSends(active, campaigns, sentLog, now, profilesById);
  report.sends = sends;
  if (dryRun) return report;

  // 3) Gửi thật (xác minh còn đang làm ngay trước khi gửi)
  if (!mcp) { mcp = new McpClient(config.mcpApiKey); await mcp.connect(); }
  const gtalk = new GtalkClient({ oaId: config.oaId, oaToken: config.oaToken, env: config.env || 'prod' });
  const imgCache = new Map(); // url -> {buffer,width,height,mimeType,fileName}
  const getImg = async (url) => { if (!imgCache.has(url)) imgCache.set(url, await resolveImage(url)); return imgCache.get(url); };

  for (const s of sends) {
    try {
      const fresh = await mcp.lookup(s.employee.employee_id, true);
      const p = fresh?.profile;
      const stillActive = p && (p.status === 1 || (p.status_text || '').includes('đang làm'));
      if (!stillActive) { report.errors.push({ employee_id: s.employee.employee_id, full_name: s.employee.full_name, campaignName: s.campaignName, day: s.day, error: 'đã nghỉ/không còn active — bỏ qua' }); continue; }

      let res;
      if (s.imageUrl) {
        const img = await getImg(s.imageUrl);
        res = await gtalk.sendImageToEmployee(s.employee.employee_id, img, s.text);
      } else {
        res = await gtalk.sendToEmployee(s.employee.employee_id, s.text, s.parseMode);
      }
      sentLog[s.key] = { at: now.toISOString(), globalMsgId: res.globalMsgId, channelId: res.channelId };
      report.sent.push({ employee_id: s.employee.employee_id, full_name: s.employee.full_name, campaignName: s.campaignName, day: s.day, ...res });
    } catch (e) {
      report.errors.push({ employee_id: s.employee.employee_id, full_name: s.employee.full_name, campaignName: s.campaignName, day: s.day, error: e.message });
    }
  }
  await store.setSentLog(sentLog);
  return report;
}

/**
 * GỬI NGAY theo danh sách employee_id (không cần mốc ngày).
 * @param {{ids:Array, text:string, dryRun:boolean, log?:function}}
 */
async function quickSend({ ids = [], text = '', parseMode = 'PLAIN_TEXT', imageUrl = '', dryRun = true, log = () => {} } = {}) {
  const config = await store.getConfig();
  if (!config) throw new Error('Chưa có cấu hình (env hoặc data/config.json).');
  imageUrl = (imageUrl || '').trim();
  if (!text.trim() && !imageUrl) throw new Error('Chưa có nội dung tin nhắn hoặc ảnh.');

  const cleanIds = [...new Set(ids.map((x) => parseInt(String(x).trim(), 10)).filter(Number.isFinite))];
  if (cleanIds.length === 0) throw new Error('Chưa có employee_id hợp lệ.');

  const mcp = new McpClient(config.mcpApiKey);
  await mcp.connect();

  // tra cứu song song (pool nhỏ); KHỚP THEO employee_id trả về, không theo vị trí
  const byId = new Map();
  let idx = 0;
  const worker = async () => {
    while (idx < cleanIds.length) {
      const id = cleanIds[idx++];
      try { const r = await mcp.lookup(id, true); if (r?.found && r.profile) byId.set(r.profile.employee_id, r.profile); }
      catch { /* bỏ qua */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, cleanIds.length) }, worker));

  const items = cleanIds.map((id) => {
    const p = byId.get(id);
    if (!p) return { employee_id: id, full_name: '(không tìm thấy)', notfound: true, text: '' };
    const active = p.status === 1 || (p.status_text || '').includes('đang làm');
    return { employee_id: id, full_name: p.full_name, title_name: p.title_name, active, notfound: false, text: renderMessage(text, p) };
  });

  const report = { dryRun, count: cleanIds.length, items, sent: [], errors: [] };
  if (dryRun) return report;

  const gtalk = new GtalkClient({ oaId: config.oaId, oaToken: config.oaToken, env: config.env || 'prod' });
  const img = imageUrl ? await resolveImage(imageUrl) : null;
  for (const it of items) {
    if (it.notfound) { report.errors.push({ employee_id: it.employee_id, error: 'không tìm thấy nhân viên' }); continue; }
    try {
      const res = img
        ? await gtalk.sendImageToEmployee(it.employee_id, img, it.text)
        : await gtalk.sendToEmployee(it.employee_id, it.text, parseMode);
      report.sent.push({ employee_id: it.employee_id, full_name: it.full_name, ...res });
    } catch (e) {
      report.errors.push({ employee_id: it.employee_id, full_name: it.full_name, error: e.message });
    }
  }
  return report;
}

module.exports = { run, quickSend };

// CLI
if (require.main === module) {
  const doRun = process.argv.includes('--run');
  run({ dryRun: !doRun, log: (m) => console.log(m) })
    .then((r) => {
      console.log(`\n${doRun ? '📤 ĐÃ GỬI' : '👀 XEM TRƯỚC (dry-run)'} — roster ${r.rosterSize} NV (lastMaxId=${r.lastMaxId})`);
      console.log(`→ ${r.sends.length} tin khớp mốc hôm nay:`);
      for (const s of r.sends) console.log(`   • [${s.campaignName}] ngày ${s.day} → ${s.employee.full_name} (${s.employee.employee_id}) — ${s.employee.title_name}`);
      if (doRun) {
        console.log(`\n✅ Gửi thành công: ${r.sent.length} | ❌ Lỗi/bỏ qua: ${r.errors.length}`);
        for (const e of r.errors) console.log(`   ✗ ${e.full_name}: ${e.error}`);
      } else if (r.sends.length) {
        console.log('\n(Chạy `node runner.js --run` để gửi thật.)');
      }
    })
    .catch((e) => { console.error('Lỗi:', e.message); process.exit(1); });
}
