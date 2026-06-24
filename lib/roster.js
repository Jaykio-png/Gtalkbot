/**
 * Roster = bộ dữ liệu nhân viên mới (bắt lúc thâm niên = captureTenureDay, mặc định 1) + lastMaxId.
 *
 * Cấu trúc data/roster.json:
 * {
 *   "lastMaxId": 3175083,        // ID lớn nhất đã quét -> hôm sau chỉ quét tiếp từ đây
 *   "updatedAt": "ISO",
 *   "employees": { "<id>": { employee_id, full_name, title_name, org,
 *                            start_working_date, leave_date, status, candidate_code, seen_at } },
 *   "scanStats": { date, scannedToday, foundToday, runsToday, lastRunAt, lastRunScanned, lastRunFound, lastMaxId, lastMode }
 * }
 *
 * HAI LUỒNG (tách riêng, crawl ít):
 *  - seed()  — chỉ chạy 1 lần để lấy BASE: nhập ID mới nhất rồi crawl LÙI, giữ NV đúng mốc thâm niên,
 *              dừng khi rời vùng đó (gặp toàn người thâm niên khác).
 *  - sync()  — hằng ngày: từ lastMaxId+1 crawl TIẾN, giữ NV đúng mốc thâm niên (NV mới mọc thêm).
 *
 * Thâm niên (số ngày làm) KHÔNG crawl lại — tính bằng phép trừ start_working_date, tự cộng dồn mỗi ngày.
 */
const { findMaxId } = require('./frontier');
const { workingDays } = require('./match');
const store = require('./store');

const slim = (p) => ({
  employee_id: p.employee_id,
  full_name: p.full_name,
  title_name: p.title_name,
  org: p.org,
  start_working_date: p.start_working_date,
  leave_date: p.leave_date,
  status: p.status,
  status_text: p.status_text,
  candidate_code: p.candidate_code,
});

// Mốc bắt NV vào bộ dữ liệu: thâm niên đúng bằng `captureTenureDay` (mặc định 1 — hồ sơ đã ổn định,
// lọc được ứng viên no-show/reject của ngày 0). Đổi qua config.captureTenureDay nếu cần.
const CAPTURE_DAY = (config) => (config.captureTenureDay ?? 1);
const isCaptureDay = (p, now, day) => workingDays(p, now) === day;

/** Ghi/cập nhật NV vào state. */
function upsert(state, list, now) {
  for (const p of list) state.employees[String(p.employee_id)] = { ...slim(p), seen_at: now.toISOString() };
}

/** Dọn NV đã quá cửa sổ campaign (qua hết các mốc) để bộ dữ liệu luôn nhỏ. */
function prune(state, maxTenure, now, log = () => {}) {
  const buffer = 7;
  let pruned = 0;
  for (const [id, p] of Object.entries(state.employees)) {
    const wd = workingDays(p, now);
    if (wd == null || wd > maxTenure + buffer) { delete state.employees[id]; pruned++; }
  }
  log(`Dọn ${pruned} NV quá ${maxTenure} ngày. Bộ dữ liệu còn ${Object.keys(state.employees).length} NV.`);
}

/** Cập nhật thống kê crawl theo NGÀY (giờ VN = UTC+7) để UI hiện "hôm nay crawl bao nhiêu NV". */
function bumpStats(state, now, { scanned, captured, maxFound, mode }) {
  const vnDate = new Date(now.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const prev = state.scanStats && state.scanStats.date === vnDate
    ? state.scanStats : { date: vnDate, scannedToday: 0, foundToday: 0, runsToday: 0 };
  state.scanStats = {
    date: vnDate,
    scannedToday: prev.scannedToday + scanned,   // tổng ID đã quét trong ngày
    foundToday: prev.foundToday + captured,       // tổng NV mới bắt được trong ngày
    runsToday: prev.runsToday + 1,                // số lần chạy crawl trong ngày
    lastRunAt: now.toISOString(),
    lastRunScanned: scanned,
    lastRunFound: captured,
    lastMaxId: maxFound,
    lastMode: mode,                               // 'seed' | 'daily'
  };
}

/**
 * LUỒNG A — SEED base.
 * Crawl LÙI từ ID mới nhất theo từng mẻ, chỉ giữ NV workingDays===0.
 * - fromId: ID mới nhất do người dùng NHẬP TAY để lùi từ đó (khỏi tốn lượt dò biên).
 *   Bỏ trống/không hợp lệ → tự dò biên bằng frontier (dự phòng).
 * Dừng khi gặp `stopAfter` mẻ liên tiếp CÓ người nhưng KHÔNG ai đúng mốc (đã rời vùng đó).
 * @param {{fromId?:number, log?:function, now?:Date}} opts
 * @returns {{state, captured:number, scanned:number, maxId:number}}
 */
async function seed(mcp, config, { fromId = null, log = () => {}, now = new Date() } = {}) {
  const state = (await store.getRoster()) || {};
  state.employees = state.employees || {};
  const conc = config.scanConcurrency || 1;        // tuần tự + throttle trong MCP client → không vượt rate limit
  const maxTenure = config.maxTenureDays || 60;
  const batch = config.scanBatch || 100;
  const cap = config.seedScanCap || 500;           // trần an toàn cho seed (≤500 để crawl ít, tránh rủi ro)
  const stopAfter = config.seedStopAfter || 2;     // số mẻ "có người, không ai đúng mốc" liên tiếp thì dừng
  const baseline = config.startFromId || 3175080;
  const captureDay = CAPTURE_DAY(config);          // thâm niên cần bắt (mặc định 1)

  // 1) Lấy ID mới nhất: ưu tiên số người dùng nhập, không có thì tự dò biên
  let maxId;
  if (fromId != null && Number.isFinite(fromId) && fromId > 0) {
    maxId = Math.floor(fromId);
    log(`Dùng ID mới nhất nhập tay = ${maxId}. Crawl LÙI tìm NV thâm niên ${captureDay} ngày...`);
  } else {
    maxId = await findMaxId(mcp, state.lastMaxId || baseline, log);
    log(`Tự dò biên: ID lớn nhất = ${maxId}. Crawl LÙI tìm NV thâm niên ${captureDay} ngày...`);
  }

  // 2) Crawl lùi từ maxId, giữ NV đúng mốc thâm niên, dừng khi rời vùng đó
  let to = maxId;
  let scanned = 0, captured = 0, leftZone = 0;
  while (scanned < cap && to >= baseline) {
    const size = Math.min(batch, cap - scanned);                 // kẹp mẻ cuối để TỔNG quét ≤ cap (≤500)
    const from = Math.max(baseline, to - size + 1);
    // includeOff=false → API bỏ qua NV "Đã nghỉ"/không active, chỉ trả người còn làm
    const found = await mcp.scanRange(from, to, { concurrency: conc, includeOff: false });
    scanned += (to - from + 1);
    const caught = found.filter((p) => isCaptureDay(p, now, captureDay));
    upsert(state, caught, now);
    captured += caught.length;
    log(`  [${from}..${to}] có ${found.length} người, ${caught.length} đúng mốc (đã bắt ${captured}).`);
    // mẻ CÓ người nhưng KHÔNG ai đúng mốc = đã đi qua hết NV thuộc mốc này
    if (found.length > 0 && caught.length === 0) { if (++leftZone >= stopAfter) break; }
    else leftZone = 0;
    to = from - 1;
  }

  state.lastMaxId = maxId;
  bumpStats(state, now, { scanned, captured, maxFound: maxId, mode: 'seed' });
  prune(state, maxTenure, now, log);
  state.updatedAt = now.toISOString();
  await store.setRoster(state);
  log(`✅ Seed xong: quét ${scanned} ID, bắt ${captured} NV (thâm niên ${captureDay} ngày). lastMaxId = ${maxId}.`);
  return { state, captured, scanned, maxId };
}

/**
 * LUỒNG B — SYNC tiến hằng ngày.
 * Từ lastMaxId+1 crawl TIẾN theo mẻ tới khi gặp mẻ trống (chạm biên), chỉ giữ NV đúng mốc thâm niên.
 * @returns {{state, active: Array, captured:number, scanned:number}}
 */
async function sync(mcp, config, log = () => {}, now = new Date()) {
  const state = (await store.getRoster()) || {};
  state.employees = state.employees || {};
  const conc = config.scanConcurrency || 1;        // tuần tự + throttle trong MCP client → không vượt rate limit
  const maxTenure = config.maxTenureDays || 60;
  const batch = config.scanBatch || 100;
  const cap = config.dailyScanCap || 500;          // ≤500 ID/ngày để crawl ít, tránh rủi ro bị chặn
  const baseline = config.startFromId || 3175080;
  const captureDay = CAPTURE_DAY(config);          // thâm niên cần bắt (mặc định 1)

  let from = (state.lastMaxId || baseline) + 1;
  let maxFound = state.lastMaxId || baseline;
  let scanned = 0, captured = 0;
  log(`Crawl TIẾN từ ${from} (mẻ ${batch}, trần ${cap} ID, ${conc} luồng) — giữ NV thâm niên ${captureDay} ngày...`);
  while (scanned < cap) {
    const size = Math.min(batch, cap - scanned);
    // includeOff=false → API bỏ qua NV "Đã nghỉ"/không active, chỉ trả người còn làm
    const found = await mcp.scanRange(from, from + size - 1, { concurrency: conc, includeOff: false });
    const caught = found.filter((p) => isCaptureDay(p, now, captureDay));
    upsert(state, caught, now);
    scanned += size;
    captured += caught.length;
    for (const p of found) if (p.employee_id > maxFound) maxFound = p.employee_id;
    from += size;
    if (found.length === 0) break; // mẻ trống = đã hết người mới (qua biên)
  }
  state.lastMaxId = maxFound;
  log(`Quét ${scanned} ID, bắt ${captured} NV (thâm niên ${captureDay} ngày). lastMaxId = ${maxFound}.`);
  if (scanned >= cap) log(`⚠️ Chạm trần ${cap} — có thể còn người mới, sẽ bắt tiếp lần chạy sau.`);

  bumpStats(state, now, { scanned, captured, maxFound, mode: 'daily' });
  prune(state, maxTenure, now, log);
  state.updatedAt = now.toISOString();
  await store.setRoster(state);

  return { state, active: Object.values(state.employees), captured, scanned };
}

module.exports = { seed, sync };
