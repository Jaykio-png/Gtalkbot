/**
 * Dò biên: tìm employee_id LỚN NHẤT hiện có.
 * ID có thể thưa (có khoảng trống), nên ta kiểm tra theo "khối" liên tiếp:
 * một khối BLOCK id mà KHÔNG có ai => coi như đã vượt biên.
 */
const BLOCK = 25; // số ID liên tiếp để kết luận "vùng trống"

async function blockHasEmployee(mcp, center, concurrency = 8) {
  const found = await mcp.scanRange(center, center + BLOCK - 1, { concurrency, includeOff: true });
  return { any: found.length > 0, maxId: found.reduce((m, p) => Math.max(m, p.employee_id), 0) };
}

/**
 * @param {McpClient} mcp  đã connect()
 * @param {number} startKnown  một ID chắc chắn tồn tại (mốc bắt đầu)
 * @param {function} log  optional
 * @returns {Promise<number>} employee_id lớn nhất tìm được
 */
async function findMaxId(mcp, startKnown, log = () => {}) {
  // 1) Nhảy lên cấp số nhân tới khi gặp vùng trống
  let lo = startKnown;          // vùng có người
  let step = 1000;
  let hi = lo + step;           // điểm đang thử
  for (let i = 0; i < 25; i++) {
    const r = await blockHasEmployee(mcp, hi);
    log(`  thử ~${hi}: ${r.any ? 'CÓ người' : 'trống'}`);
    if (r.any) { lo = hi; step *= 2; hi = lo + step; }
    else break;                 // hi là vùng trống => biên nằm giữa lo..hi
  }

  // 2) Tìm nhị phân mép giữa lo (có người) và hi (trống)
  while (hi - lo > BLOCK) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await blockHasEmployee(mcp, mid);
    log(`  nhị phân [${lo}..${hi}] mid ${mid}: ${r.any ? 'CÓ' : 'trống'}`);
    if (r.any) lo = mid; else hi = mid;
  }

  // 3) Quét chính xác quanh mép để lấy ID lớn nhất thật
  const around = await mcp.scanRange(lo, lo + BLOCK * 2, { concurrency: 8, includeOff: true });
  const maxId = around.reduce((m, p) => Math.max(m, p.employee_id), lo);
  return maxId;
}

module.exports = { findMaxId };
