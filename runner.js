/**
 * Bộ chạy: đồng bộ roster (dò biên + quét ID mới) -> khớp lộ trình -> (xem trước | gửi).
 * Dùng cho:
 *   - server.js (endpoint /api/preview, /api/run)
 *   - cron hằng ngày:  node runner.js --run
 *   - xem trước CLI:   node runner.js
 */
const { McpClient } = require('./lib/mcp');
const { GtalkClient } = require('./lib/gtalk');
const { computeSends, renderMessage, isActive } = require('./lib/match');
const { resolveImage } = require('./lib/image');
const roster = require('./lib/roster');
const store = require('./lib/store');

/**
 * Gửi ẢNH (kèm chữ) cho 1 nhân viên — LUÔN gửi 1 tin duy nhất (ảnh + caption dính liền nhau).
 * caption mang theo parseMode để render định dạng (HTML/MARKDOWN) ngay trong tin ảnh,
 * không tách thành 2 tin nữa.
 */
function sendImageMessage(gtalk, employeeId, img, text, parseMode = 'PLAIN_TEXT') {
  return gtalk.sendImageToEmployee(employeeId, img, text, parseMode);
}

async function run({ dryRun = true, sync = null, onlyCampaignId = null, log = () => {}, now = new Date() } = {}) {
  const config = await store.getConfig();
  if (!config) throw new Error('Chưa có cấu hình (env hoặc data/config.json).');
  // Lọc lộ trình đang bật; nếu chỉ định onlyCampaignId thì chỉ chạy đúng lộ trình đó (cho lịch riêng từng lộ trình)
  const campaigns = (await store.getCampaigns())
    .filter((c) => c.enabled !== false)
    .filter((c) => onlyCampaignId == null || String(c.id) === String(onlyCampaignId));

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

  // 2) Tra cứu các ID cố định (targetIds) — CHỈ dùng roster (danh sách đã crawl), KHÔNG gọi API mới
  const rosterData = (await store.getRoster()) || {};
  const rosterEmployees = rosterData.employees || {};
  const targetIds = [...new Set(campaigns.flatMap((c) => (c.targetIds || []).map(Number)).filter(Number.isFinite))];
  const profilesById = {};
  if (targetIds.length) {
    let miss = 0;
    for (const id of targetIds) {
      const cached = rosterEmployees[String(id)];
      if (cached) profilesById[id] = cached; else miss++;
    }
    log(`Tra cứu ${targetIds.length} ID cố định trong roster → có ${targetIds.length - miss}, thiếu ${miss} (bỏ qua, không crawl mới).`);
  }

  // 3) Khớp -> tin cần gửi hôm nay
  const sentLog = await store.getSentLog();
  const sends = computeSends(active, campaigns, sentLog, now, profilesById);
  report.sends = sends;
  if (dryRun) return report;

  // 3) Gửi thật — dùng trạng thái đã lưu trong roster, KHÔNG gọi API xác minh lại (không crawl)
  const gtalk = new GtalkClient({ oaId: config.oaId, oaToken: config.oaToken, env: config.env || 'prod' });
  const imgCache = new Map(); // url -> {buffer,width,height,mimeType,fileName}
  const getImg = async (url) => { if (!imgCache.has(url)) imgCache.set(url, await resolveImage(url)); return imgCache.get(url); };

  for (const s of sends) {
    try {
      if (!isActive(s.employee)) { report.errors.push({ employee_id: s.employee.employee_id, full_name: s.employee.full_name, campaignName: s.campaignName, day: s.day, error: 'không còn active trong danh sách — bỏ qua' }); continue; }

      let res;
      if (s.imageUrl) {
        const img = await getImg(s.imageUrl);
        res = await sendImageMessage(gtalk, s.employee.employee_id, img, s.text, s.parseMode);
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
 * directFire = true → bắn thẳng, KHÔNG crawl/lookup MCP, chỉ cần employee_id.
 * @param {{ids:Array, text:string, dryRun:boolean, directFire:boolean, log?:function}}
 */
function hashKey(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }

async function quickSend({ ids = [], text = '', parseMode = 'PLAIN_TEXT', imageUrl = '', dryRun = true, directFire = false, resume = false, sendConcurrency = 3, onItem = null, log = () => {} } = {}) {
  const config = await store.getConfig();
  if (!config) throw new Error('Chưa có cấu hình (env hoặc data/config.json).');
  imageUrl = (imageUrl || '').trim();
  if (!text.trim() && !imageUrl) throw new Error('Chưa có nội dung tin nhắn hoặc ảnh.');

  const cleanIds = [...new Set(ids.map((x) => parseInt(String(x).trim(), 10)).filter(Number.isFinite))];
  if (cleanIds.length === 0) throw new Error('Chưa có employee_id hợp lệ.');

  let byId = new Map();

  if (directFire) {
    // === CHẾ ĐỘ BẮN THẲNG: không crawl MCP, chỉ dùng roster local (nếu có) để hiển thị tên ===
    const rosterData = (await store.getRoster()) || {};
    const rosterEmployees = rosterData.employees || {};
    for (const id of cleanIds) {
      const cached = rosterEmployees[String(id)];
      // Dùng cache nếu có (chỉ để hiện tên), nếu không thì tạo placeholder
      byId.set(id, cached || { employee_id: id, full_name: `NV #${id}`, title_name: '', status: 1, status_text: 'đang làm việc' });
    }
    log(`⚡ Bắn thẳng: ${cleanIds.length} ID — không crawl MCP.`);
  } else {
    // === CHẾ ĐỘ THƯỜNG: cache-first, lookup thiếu ===
    const rosterData = (await store.getRoster()) || {};
    const rosterEmployees = rosterData.employees || {};
    const missingIds = [];
    for (const id of cleanIds) {
      const cached = rosterEmployees[String(id)];
      if (cached) { byId.set(id, cached); }
      else { missingIds.push(id); }
    }
    log(`Gửi nhanh: ${cleanIds.length} ID → ${cleanIds.length - missingIds.length} có sẵn trong roster, ${missingIds.length} cần gọi API.`);

    // Chỉ gọi MCP API cho các ID chưa có trong roster
    if (missingIds.length) {
      const mcp = new McpClient(config.mcpApiKey);
      await mcp.connect();
      const pool = Math.min(3, missingIds.length);
      let idx = 0;
      const worker = async () => {
        while (idx < missingIds.length) {
          const id = missingIds[idx++];
          try { const r = await mcp.lookup(id, true); if (r?.found && r.profile) byId.set(r.profile.employee_id, r.profile); }
          catch { /* bỏ qua */ }
        }
      };
      await Promise.all(Array.from({ length: pool }, worker));
      // 1 ID = 1 lượt gọi: ID nào không tra được thì pass (không gọi lại lần nữa).
    }
  }

  const items = cleanIds.map((id) => {
    const p = byId.get(id);
    if (!p) return { employee_id: id, full_name: '(không tìm thấy)', notfound: true, text: '' };
    const active = directFire ? true : (p.status === 1 || (p.status_text || '').includes('đang làm'));
    return { employee_id: id, full_name: p.full_name, title_name: p.title_name || '', active, notfound: false, text: renderMessage(text, p) };
  });

  const report = { dryRun, directFire, count: cleanIds.length, items, sent: [], errors: [] };
  if (dryRun) return report;

  const gtalk = new GtalkClient({ oaId: config.oaId, oaToken: config.oaToken, env: config.env || 'prod' });
  const img = imageUrl ? await resolveImage(imageUrl) : null;
  const sentLog = await store.getSentLog();
  const bkey = 'blast:' + hashKey(`${parseMode}|${imageUrl}|${text}`); // khóa nhận diện "mẻ bắn" (để resume)
  let i = 0, persisted = 0;

  const sendOne = async (it) => {
    if (it.notfound && !directFire) {
      it.status = 'notfound';
      report.errors.push({ employee_id: it.employee_id, error: 'không tìm thấy nhân viên' });
      if (onItem) onItem(it); return;
    }
    const logKey = `${bkey}:${it.employee_id}`;
    if (resume && sentLog[logKey]) { it.status = 'skipped'; if (onItem) onItem(it); return; }
    try {
      const res = img
        ? await sendImageMessage(gtalk, it.employee_id, img, it.text, parseMode)
        : await gtalk.sendToEmployee(it.employee_id, it.text, parseMode);
      sentLog[logKey] = { at: new Date().toISOString() };
      it.status = 'ok';
      report.sent.push({ employee_id: it.employee_id, full_name: it.full_name, ...res });
    } catch (e) {
      it.status = 'error'; it.error = e.message;
      report.errors.push({ employee_id: it.employee_id, full_name: it.full_name, error: e.message });
    }
    if (onItem) onItem(it);
    if (++persisted % 25 === 0) { try { await store.setSentLog(sentLog); } catch { /* */ } }
  };

  const conc = Math.min(sendConcurrency || 3, items.length || 1);
  await Promise.all(Array.from({ length: conc }, async () => { while (i < items.length) await sendOne(items[i++]); }));
  try { await store.setSentLog(sentLog); } catch { /* */ }
  return report;
}

/**
 * LUỒNG CRAWL (tách riêng khỏi gửi) — chỉ quét ID mới (roster.sync tiến), KHÔNG gửi tin.
 * Dùng cho cron crawl hằng ngày: node runner.js --crawl
 */
async function crawl({ log = () => {}, now = new Date() } = {}) {
  const config = await store.getConfig();
  if (!config) throw new Error('Chưa có cấu hình (env hoặc data/config.json).');
  const mcp = new McpClient(config.mcpApiKey);
  await mcp.connect();
  const { state, captured, scanned } = await roster.sync(mcp, config, log, now);
  return { lastMaxId: state.lastMaxId, rosterSize: Object.keys(state.employees || {}).length, captured, scanned, scanStats: state.scanStats };
}

module.exports = { run, crawl, quickSend };

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--crawl')) {
    // === JOB CRAWL: chỉ quét ID mới, không gửi ===
    crawl({ log: (m) => console.log(m) })
      .then((r) => {
        console.log(`\n🔄 CRAWL xong — quét ${r.scanned} ID, bắt ${r.captured} NV mới. Roster ${r.rosterSize} NV (lastMaxId=${r.lastMaxId}).`);
      })
      .catch((e) => { console.error('Lỗi crawl:', e.message); process.exit(1); });
  } else {
    // === JOB GỬI: --run = gửi thật (KHÔNG crawl, dùng roster do job crawl đã quét). Không cờ = xem trước ===
    const doRun = args.includes('--run');
    run({ dryRun: !doRun, sync: doRun ? false : null, log: (m) => console.log(m) })
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
}
