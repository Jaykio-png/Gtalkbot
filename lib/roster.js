/**
 * Roster = bộ nhớ nhân viên + lastMaxId.
 *
 * Cấu trúc data/roster.json:
 * {
 *   "lastMaxId": 3175083,        // ID lớn nhất đã quét -> hôm sau chỉ quét tiếp từ đây
 *   "backfilledFrom": 3165000,
 *   "updatedAt": "ISO",
 *   "employees": { "<id>": { employee_id, full_name, title_name, org,
 *                            start_working_date, leave_date, status, candidate_code, seen_at } }
 * }
 *
 * Ý tưởng:
 *  - Lần đầu: BACKFILL — dò biên rồi quét rộng lùi xuống (phủ > maxTenure ngày).
 *  - Mỗi ngày: chỉ quét ID MỚI mọc thêm (từ lastMaxId+1 tới biên mới).
 *  - start_working_date cố định -> tính số ngày bằng phép trừ, không tra lại người cũ.
 *  - Dọn (prune) người đã quá maxTenure ngày để roster luôn nhỏ.
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

/**
 * Đồng bộ roster.
 * @returns {{state, active: Array}} state đã lưu + danh sách NV còn trong cửa sổ (để khớp)
 */
async function sync(mcp, config, log = () => {}, now = new Date()) {
  const state = (await store.getRoster()) || {};
  state.employees = state.employees || {};
  const conc = config.concurrency || 4;            // nhẹ tay, tránh bị cấm lại
  const maxTenure = config.maxTenureDays || 60;
  const batch = config.scanBatch || 100;           // mỗi mẻ quét bao nhiêu ID
  const cap = config.dailyScanCap || 600;          // TRẦN an toàn (chỉ bung khi ngày tuyển đông)
  const baseline = config.startFromId || 3175080;  // mốc khởi đầu nếu chưa có lastMaxId

  const upsert = (list) => { for (const p of list) state.employees[String(p.employee_id)] = { ...slim(p), seen_at: now.toISOString() }; };

  // ----- QUÉT THÍCH ỨNG: mẻ nhỏ, dừng khi gặp mẻ trống (chạm biên), tối đa `cap` ID -----
  let from = (state.lastMaxId || baseline) + 1;
  let maxFound = state.lastMaxId || baseline;
  let scanned = 0, totalFound = 0;
  log(`Quét thích ứng từ ${from} (mẻ ${batch}, trần ${cap} ID, ${conc} luồng)...`);
  while (scanned < cap) {
    const size = Math.min(batch, cap - scanned);
    const found = await mcp.scanRange(from, from + size - 1, { concurrency: conc, includeOff: true });
    upsert(found);
    scanned += size;
    totalFound += found.length;
    for (const p of found) if (p.employee_id > maxFound) maxFound = p.employee_id;
    from += size;
    if (found.length === 0) break; // mẻ trống = đã hết người mới (qua biên)
  }
  state.lastMaxId = maxFound;
  log(`Quét ${scanned} ID, tìm ${totalFound} người mới. lastMaxId = ${maxFound}.`);
  if (scanned >= cap) log(`⚠️ Chạm trần ${cap} — có thể còn người mới, sẽ bắt tiếp lần chạy sau.`);

  // ----- Dọn người đã quá cửa sổ (qua hết các mốc) -----
  const buffer = 7;
  let pruned = 0;
  for (const [id, p] of Object.entries(state.employees)) {
    const wd = workingDays(p, now);
    if (wd == null || wd > maxTenure + buffer) { delete state.employees[id]; pruned++; }
  }
  state.updatedAt = now.toISOString();
  await store.setRoster(state);
  log(`Dọn ${pruned} NV quá ${maxTenure} ngày. Roster còn ${Object.keys(state.employees).length} NV.`);

  return { state, active: Object.values(state.employees) };
}

module.exports = { sync };
