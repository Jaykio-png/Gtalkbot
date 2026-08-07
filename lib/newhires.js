/**
 * "NV mới mỗi ngày" — lấy nhân viên có NGÀY VÀO LÀM là hôm qua hoặc hôm nay, qua Data API.
 *
 * Khác với crawl MCP (quét từng employee_id, chậm, hay sót người chốt muộn): ở đây hỏi thẳng
 * dim_employee theo ngày nên KHÔNG THỂ sót — ai có start_working_date trong khoảng là ra hết.
 * Tốn đúng 1 lượt quota mỗi lần chạy.
 *
 * Vì sao lấy 2 ngày chứ không chỉ hôm nay: hồ sơ HR hay CHỐT MUỘN — người vào hôm qua có thể
 * tới hôm nay mới có mặt trong warehouse. Quét chồng 1 ngày để vớt lại. (Cùng lý do với
 * rescanOverlap bên lib/roster.js.)
 *
 * ⚠️ warehouse_id là SỐ, không có tên bưu cục: token hiện chỉ được whitelist đúng bảng
 * dim_employee — dim_warehouse lẫn information_schema đều trả 403 forbidden. Muốn hiện tên
 * bưu cục phải xin Data team mở quyền bảng warehouse, rồi JOIN thêm ở buildSQL().
 *
 * Kết quả lưu theo NGÀY CHẠY (giờ VN): { 'YYYY-MM-DD': { runAt, days, items, stats } }
 * — giữ RETAIN_DAYS ngày gần nhất rồi tự dọn cho nhẹ.
 */
const store = require('./store');
const RETAIN_DAYS = 30;
const VN_OFFSET_MS = 7 * 3600 * 1000;

/** Ngày hôm nay theo giờ VN, dạng YYYY-MM-DD. */
function vnToday(now = new Date()) {
  return new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}
/** Lùi n ngày từ 1 chuỗi YYYY-MM-DD. */
function minusDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Lọc NV vào làm trong khoảng [from..to] ra khỏi danh bạ ĐÃ kéo về.
 *
 * Trước đây đây là 1 câu SQL riêng — bỏ rồi. Quota tính theo LƯỢT QUERY chứ không theo số dòng,
 * nên kéo 139 dòng và kéo 22.6k dòng đều tốn 1 lượt: tách 2 query là trả giá gấp đôi cho việc
 * mà 1 query làm được. Giờ mỗi ngày kéo full 1 lần → vừa làm mới danh bạ (người nghỉ/chuyển
 * phòng tự cập nhật, không trôi dần như kiểu chỉ append), vừa lọc ra NV mới từ chính đống đó.
 */
function pickFromDir(dir, from, to) {
  const c = dir.columns;
  const iStart = c.indexOf('start_working_date');
  const out = [];
  for (const row of dir.rows) {
    const d = String(row[iStart] || '').slice(0, 10);
    if (!d || d < from || d > to) continue; // chuỗi 'YYYY-MM-DD' so được trực tiếp
    const o = {};
    for (let i = 0; i < c.length; i++) o[c[i]] = row[i];
    out.push({
      ...o,
      start_date: d,
      end_date: String(o.termination_date || '').slice(0, 10),
      warehouse_id: o.warehouse_id != null ? Number(o.warehouse_id) : null,
      warehouse_name: require('./warehouses').warehouseName(o.warehouse_id),
      unit_id: o.unit_id != null ? Number(o.unit_id) : null,
    });
  }
  out.sort((a, b) => (a.start_date < b.start_date ? 1 : a.start_date > b.start_date ? -1 : a.employee_id - b.employee_id));
  return out;
}

/**
 * Lượt chạy hằng ngày — MỘT query lo cả hai việc:
 *   1) kéo full dim_employee → ghi đè danh bạ 'org-dir' (người nghỉ/chuyển phòng tự cập nhật)
 *   2) lọc trong đó ra NV vào làm hôm qua/hôm nay → ghép vào roster + lưu theo ngày
 * Tốn ĐÚNG 1 lượt quota.
 *
 * @param {DapClient} dap
 * @param {{now?:Date, backDays?:number, onProgress?:function}} opts backDays=1 → lấy hôm qua + hôm nay.
 * @returns {{date, runAt, days, items, merged, dirCount, stats, quotaRemaining}}
 */
async function run(dap, { now = new Date(), backDays = 1, onProgress } = {}) {
  const today = vnToday(now);
  const from = minusDays(today, Math.max(0, backDays));

  // 1 query duy nhất. Danh bạ chỉ lấy status='1' → NV mới mà đã nghỉ ngay thì không lọt vào
  // danh sách, đúng ý: lộ trình Tân thủ không nên bắn cho người đã nghỉ.
  const orgdir = require('./orgdir');
  const dir = await orgdir.sync(dap, { includeOff: false, onProgress });

  const items = pickFromDir(dir, from, today);

  // Ghép thẳng vào roster để lộ trình Tân thủ bắn được — đây mới là mục đích chính,
  // bản lưu theo ngày bên dưới chỉ để xem lại/đối chiếu.
  const merged = await mergeIntoRoster(items, now);

  const entry = {
    runAt: now.toISOString(),
    days: [from, today],
    count: items.length,
    items,
    merged,
    dirCount: dir.count,
    stats: dir.stats || null,
  };

  const all = (await store.getNewHires()) || {};
  all[today] = entry;
  // Dọn ngày cũ — chỉ giữ RETAIN_DAYS khóa mới nhất
  for (const k of Object.keys(all).sort().slice(0, -RETAIN_DAYS)) delete all[k];
  await store.setNewHires(all);

  return { date: today, ...entry, quotaRemaining: dap.quotaRemaining };
}

/* ================================================================
   Ghép vào roster — để lộ trình Tân thủ bắn được cho người mới
   ================================================================ */

/**
 * '2026-08-07' → '2026-08-06T17:00:00Z' (nửa đêm giờ VN, biểu diễn ở UTC).
 *
 * BẮT BUỘC phải đổi, không được bê nguyên chuỗi ngày: MCP lưu đúng kiểu này, còn 'YYYY-MM-DD'
 * new Date() hiểu là nửa đêm UTC — lệch 7 tiếng. Hệ quả: workingDays() ra số khác nhau giữa
 * 00:00–07:00 giờ VN, tức cùng một người mà hai nguồn tính thâm niên lệch 1 ngày → bắn nhầm mốc.
 */
function vnMidnightISO(dateStr) {
  const s = String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  return new Date(new Date(s + 'T00:00:00Z').getTime() - VN_OFFSET_MS).toISOString().replace('.000', '');
}

/**
 * Đổi 1 dòng dim_employee sang ĐÚNG shape roster mà lib/match.js đọc được.
 * Ba chỗ sai là hỏng ngầm, không báo lỗi:
 *   - status phải là SỐ (isActive so `=== 1`, chuỗi '1' sẽ ra false → loại khỏi mọi lộ trình)
 *   - ngày phải là nửa đêm giờ VN (xem vnMidnightISO)
 *   - org phải là chuỗi ghép '/' (parseOrg tách bằng '/')
 */
function toRosterProfile(x, now = new Date()) {
  const status = Number(x.status);
  return {
    employee_id: Number(x.employee_id),
    full_name: String(x.employee_name || '').trim(),
    title_name: String(x.jobtitle_name_vn || x.jobtitle_name || '').trim(),
    org: require('./orgdir').joinOrg(x),
    start_working_date: vnMidnightISO(x.start_date),
    leave_date: vnMidnightISO(x.end_date), // '' nếu chưa nghỉ — match.js coi '' là chưa nghỉ
    status,
    status_text: status === 1 ? 'đang làm việc' : 'đã nghỉ',
    seen_at: now.toISOString(),
    source: 'dap',            // đánh dấu nguồn để lần sau còn biết ai vào bằng đường nào
    warehouse_id: x.warehouse_id != null ? Number(x.warehouse_id) : null,
    unit_id: x.unit_id != null ? Number(x.unit_id) : null,
  };
}

/** Bơm warehouse_name vào danh sách đã lưu (tra lúc đọc, xem chú thích ở orgdir.rowToObject). */
function withWarehouseNames(items) {
  const { warehouseName } = require('./warehouses');
  return (items || []).map((x) => ({ ...x, warehouse_name: warehouseName(x.warehouse_id) }));
}

/**
 * Ghép danh sách NV mới vào roster.
 * - Người CHƯA có  → thêm mới (đây là những người crawl MCP bỏ sót).
 * - Người ĐÃ có    → chỉ vá các trường DAP biết rõ hơn (org 4 cấp, warehouse_id, chức danh),
 *                    GIỮ NGUYÊN candidate_code/seen_at cũ vì MCP có mà DAP không có.
 * Không đụng lastMaxId/scanStats — đó là việc của crawl MCP.
 * @returns {{added:number, updated:number, total:number}}
 */
async function mergeIntoRoster(items, now = new Date()) {
  const state = (await store.getRoster()) || {};
  state.employees = state.employees || {};

  let added = 0, updated = 0;
  for (const x of items) {
    const p = toRosterProfile(x, now);
    if (!p.employee_id || !p.start_working_date) continue; // thiếu 2 thứ này thì vô dụng, bỏ
    const key = String(p.employee_id);
    const cu = state.employees[key];
    if (!cu) {
      state.employees[key] = p;
      added++;
    } else {
      // Vá chứ không đè: giữ lại thứ MCP có mà DAP không có.
      state.employees[key] = {
        ...cu,
        org: p.org || cu.org,
        title_name: p.title_name || cu.title_name,
        warehouse_id: p.warehouse_id ?? cu.warehouse_id ?? null,
        unit_id: p.unit_id ?? cu.unit_id ?? null,
        status: p.status,
        status_text: p.status_text,
        leave_date: p.leave_date || cu.leave_date || '',
      };
      updated++;
    }
  }

  state.updatedAt = now.toISOString();
  await store.setRoster(state);
  return { added, updated, total: Object.keys(state.employees).length };
}

/** Danh sách ngày đã chạy, mới nhất trước. */
async function listDates() {
  const all = (await store.getNewHires()) || {};
  return Object.keys(all).sort().reverse();
}

/** Lấy kết quả 1 ngày chạy (mặc định ngày mới nhất). Trả null nếu chưa có. */
async function getRun(date) {
  const all = (await store.getNewHires()) || {};
  const keys = Object.keys(all).sort();
  const key = date && all[date] ? date : keys[keys.length - 1];
  if (!key) return null;
  // Tra tên kho lúc ĐỌC, không lưu sẵn — cập nhật danh mục là các ngày cũ cũng có tên ngay.
  return { date: key, ...all[key], items: withWarehouseNames(all[key].items) };
}

module.exports = {
  run, listDates, getRun, pickFromDir, vnToday, minusDays, RETAIN_DAYS,
  mergeIntoRoster, toRosterProfile, vnMidnightISO, withWarehouseNames,
};
