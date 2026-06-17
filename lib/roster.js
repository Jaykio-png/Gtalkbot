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
  const conc = config.concurrency || 8;
  const maxTenure = config.maxTenureDays || 60;
  const span = config.backfillIdSpan || 10000;

  const upsert = (list) => { for (const p of list) state.employees[String(p.employee_id)] = { ...slim(p), seen_at: now.toISOString() }; };

  if (!state.lastMaxId) {
    // ----- BACKFILL lần đầu -----
    log('Backfill lần đầu: đang dò biên...');
    const frontier = await findMaxId(mcp, config.frontierStartGuess || 3170000, log);
    const from = frontier - span;
    log(`Dò ra biên ${frontier}. Quét rộng ${from}..${frontier} (~${span} ID)...`);
    const all = await mcp.scanRange(from, frontier, { concurrency: conc, includeOff: true, onProgress: (d, t, f) => { if (d % 500 === 0) log(`  quét ${d}/${t} — tìm ${f}`); } });
    upsert(all);
    state.lastMaxId = frontier;
    state.backfilledFrom = from;
    log(`Backfill xong: ${all.length} NV.`);
  } else {
    // ----- Hằng ngày: quét PHẲNG tiến lên (song song) cho tới khi nửa cuối cửa sổ trống -----
    log(`Quét tiếp từ lastMaxId=${state.lastMaxId} (cửa sổ phẳng, ${conc} luồng)...`);
    const WIN = 400;
    let from = state.lastMaxId + 1;
    let newMax = state.lastMaxId;
    let total = 0;
    for (let g = 0; g < 50; g++) {
      const found = await mcp.scanRange(from, from + WIN - 1, { concurrency: conc, includeOff: true });
      upsert(found);
      total += found.length;
      for (const p of found) if (p.employee_id > newMax) newMax = p.employee_id;
      const topHalf = found.filter((p) => p.employee_id >= from + WIN / 2).length;
      from += WIN;
      if (topHalf === 0) break; // nửa cuối trống => đã qua biên
    }
    state.lastMaxId = Math.max(state.lastMaxId, newMax);
    log(`Có ${total} ID mới. lastMaxId mới = ${state.lastMaxId}.`);
  }

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
