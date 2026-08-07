/**
 * Danh bạ tổ chức (org directory) — kéo từ "dw-ghn".datawarehouse.dim_employee qua Data API.
 *
 * Vì sao cần: roster (crawl MCP) chỉ có `org` là 1 chuỗi "Khối / Phòng" — không có team/section,
 * và chỉ chứa NV MỚI (đã prune sau ~60 ngày). dim_employee cho CẢ CÂY tổ chức 4 cấp
 * (division → department → section → team) + jobtitle của quản lý từng cấp, cho TOÀN bộ nhân sự.
 *
 * LƯU DẠNG CỘT — { columns, rows } y như API trả, KHÔNG đổi sang mảng object:
 * ~22.6k NV đang làm; dạng object lặp lại tên khóa 22.6k lần (~4.5MB), dạng cột chỉ ~1.8MB.
 * Quan trọng vì cả cục nằm trong 1 dòng jsonb của Supabase.
 *
 * Ngày tháng: dim_employee trả start_working_date lúc 07:00 UTC (= 14:00 giờ VN) nên phần NGÀY
 * giống nhau ở cả hai múi giờ → cắt thẳng 10 ký tự đầu là an toàn, không lệch 1 ngày như
 * mấy chỗ khác trong hệ thống (xem ghi chú múi giờ ở lib/match.js enrolledIn).
 */
const store = require('./store');

const TABLE = '"dw-ghn".datawarehouse.dim_employee';

// Cột lấy về — thứ tự này cũng là thứ tự cột lưu trong store.
//
// Chỉ giữ cột THẬT SỰ dùng: cả cục nằm trong 1 ô jsonb Supabase nên mỗi cột thừa nhân với
// 22.6k dòng là mất vài trăm KB. Đã bỏ 6 cột:
//   - 4 cột *_manager_jobtitle_id : định dùng cho cây tổ chức nhưng cây chỉ dựng từ TÊN  (-10%)
//   - jobtitle_name (tiếng Anh)   : UI chỉ hiện bản _vn                                  (-19%)
//   - jobtitle_id                 : không tra cứu theo id chức danh ở đâu cả
// Đo thật: 4,34 MB → 3,09 MB.
//
// Ngược lại THÊM 2 cột cho luồng "NV mới mỗi ngày" (dùng chung 1 query, xem lib/newhires.js):
//   - warehouse_id     : bưu cục/kho
//   - termination_date : để suy ra leave_date khi ghép vào roster
const COLUMNS = [
  'employee_id', 'employee_name', 'jobtitle_name_vn',
  'status', 'start_working_date', 'termination_date',
  'unit_id', 'warehouse_id',
  'team_name', 'section_name', 'department_name', 'division_name',
];

// status trong dim_employee là varchar: '1' đang làm (~22.6k), '0' đã nghỉ (~147k), '-1' (~277, hồ sơ lỗi/huỷ).
const STATUS_TEXT = { '1': 'Đang làm', '0': 'Đã nghỉ', '-1': 'Không hợp lệ' };

/**
 * Câu SQL kéo danh bạ.
 * @param {{includeOff?:boolean, limit?:number}} opts includeOff=true thì lấy cả NV đã nghỉ (~170k dòng, nặng).
 */
function buildSQL({ includeOff = false, limit = 0 } = {}) {
  const where = includeOff ? '' : " WHERE status = '1'";
  const tail = limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '';
  return `SELECT ${COLUMNS.join(', ')} FROM ${TABLE}${where}${tail}`;
}

/**
 * Bỏ dấu + thường hoá để tìm kiếm: 'Nguyễn Văn Đức' → 'nguyen van duc'.
 * Không có cái này thì gõ 'nguyen' không ra ai — mà người dùng gõ không dấu là chính.
 * đ/Đ phải thay tay vì NFD không tách được (nó là ký tự riêng, không phải d + dấu).
 */
function fold(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase();
}

/** '2012-06-20 07:00:00.000000 UTC' → '2012-06-20'. Trả '' nếu rỗng/không hợp lệ. */
function toDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/**
 * Kéo toàn bộ danh bạ về và lưu vào store (key 'org-dir').
 * Tốn ĐÚNG 1 lượt quota bất kể bao nhiêu batch.
 * @param {import('./dap').DapClient} dap
 * @returns {{updatedAt, columns, rows, count, stats, quotaRemaining}}
 */
async function sync(dap, { includeOff = false, onProgress, signal } = {}) {
  const sql = buildSQL({ includeOff });
  const { columns, rows, stats } = await dap.query(sql, { onProgress, signal, maxRows: 250000 });

  // Chuẩn hoá ngay lúc lưu: ngày về 'YYYY-MM-DD', tên trim.
  const iDate = columns.indexOf('start_working_date');
  const iEnd = columns.indexOf('termination_date');
  const iName = columns.indexOf('employee_name');
  for (const r of rows) {
    if (iDate >= 0) r[iDate] = toDate(r[iDate]);
    if (iEnd >= 0) r[iEnd] = toDate(r[iEnd]);
    if (iName >= 0) r[iName] = String(r[iName] || '').trim();
  }

  const dir = {
    updatedAt: new Date().toISOString(),
    includeOff,
    columns,
    rows,
    count: rows.length,
    stats: stats || null,
  };
  await store.setOrgDir(dir);
  return { ...dir, quotaRemaining: dap.quotaRemaining };
}

/** Đọc danh bạ đã lưu. Trả null nếu chưa sync lần nào. */
async function load() {
  const dir = await store.getOrgDir();
  return dir && Array.isArray(dir.rows) && dir.rows.length ? dir : null;
}

/**
 * Đổi 1 dòng dạng cột → object có tên trường (dùng khi trả về UI, không lưu).
 * Bơm thêm warehouse_name tra từ danh mục dán tay — KHÔNG lưu vào store, tra lúc đọc
 * để sau này cập nhật danh mục là có hiệu lực ngay, khỏi phải đồng bộ lại 22.6k dòng.
 */
function rowToObject(columns, row) {
  const o = {};
  for (let i = 0; i < columns.length; i++) o[columns[i]] = row[i];
  o.status_text = STATUS_TEXT[String(o.status)] || String(o.status || '');
  o.warehouse_name = require('./warehouses').warehouseName(o.warehouse_id);
  return o;
}

/**
 * Ghép org 4 cấp thành chuỗi 'A / B / C / D' — đúng định dạng org của MCP, vì match.js
 * parseOrg() tách bằng '/'. Nhận object có division_name/department_name/section_name/team_name.
 */
function joinOrg(x) {
  return [x.division_name, x.department_name, x.section_name, x.team_name]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' / ');
}

/**
 * Vá roster từ danh bạ: điền org 4 cấp + warehouse_id + unit_id + chức danh cho những
 * hồ sơ crawl bằng MCP (MCP đã ngừng trả org đầy đủ từ ~07/2026 và chưa từng có warehouse_id).
 *
 * CHỈ vá, không thêm người mới và không xoá ai — người không có trong danh bạ (đã nghỉ, vì
 * danh bạ chỉ lấy status='1') thì để nguyên. Không đụng lastMaxId/scanStats của crawl MCP.
 *
 * Không lưu TÊN kho, chỉ lưu mã: tên tra lúc đọc từ lib/warehouses.js, nên sau này bổ sung
 * danh mục là tự hiện tên, khỏi phải chạy vá lại.
 *
 * @param {{dryRun?:boolean, now?:Date}} opts dryRun=true → chỉ đếm, không ghi.
 * @returns {{scanned, patchedOrg, patchedWh, patchedTitle, touched, total}}
 */
async function backfillRoster({ dryRun = false, now = new Date() } = {}) {
  const dir = await load();
  if (!dir) throw new Error('Chưa có danh bạ — đồng bộ trước đã.');
  const state = (await store.getRoster()) || {};
  state.employees = state.employees || {};

  const idx = indexById(dir);
  const c = dir.columns;
  const at = (row, f) => { const i = c.indexOf(f); return i < 0 ? null : row[i]; };

  let scanned = 0, patchedOrg = 0, patchedWh = 0, patchedTitle = 0, touched = 0;
  for (const p of Object.values(state.employees)) {
    const row = idx.get(Number(p.employee_id));
    if (!row) continue;
    scanned++;
    let hit = false;

    const org = joinOrg({
      division_name: at(row, 'division_name'), department_name: at(row, 'department_name'),
      section_name: at(row, 'section_name'), team_name: at(row, 'team_name'),
    });
    // Chỉ ghi đè khi org mới SÂU HƠN — đừng làm nghèo dữ liệu cũ (hồ sơ crawl tháng 5-6 còn
    // giữ 5 cấp có tên bưu cục, danh bạ DAP chỉ tới cấp Zone là 4).
    const sau = (s) => String(s || '').split('/').filter((x) => x.trim()).length;
    if (org && sau(org) > sau(p.org)) { p.org = org; patchedOrg++; hit = true; }

    const wh = at(row, 'warehouse_id');
    if (wh != null && p.warehouse_id == null) { p.warehouse_id = Number(wh); patchedWh++; hit = true; }
    const unit = at(row, 'unit_id');
    if (unit != null && p.unit_id == null) p.unit_id = Number(unit);

    const title = String(at(row, 'jobtitle_name_vn') || '').trim();
    if (title && !p.title_name) { p.title_name = title; patchedTitle++; hit = true; }

    if (hit) touched++;
  }

  if (!dryRun) {
    state.updatedAt = now.toISOString();
    await store.setRoster(state);
  }
  return { scanned, patchedOrg, patchedWh, patchedTitle, touched, total: Object.keys(state.employees).length };
}

/** Map employee_id → object, để tra nhanh khi ghép vào roster. */
function indexById(dir) {
  const idx = new Map();
  if (!dir) return idx;
  const i = dir.columns.indexOf('employee_id');
  for (const row of dir.rows) idx.set(Number(row[i]), row);
  return idx;
}

/**
 * Cây tổ chức 4 cấp + số NV mỗi nhánh.
 * Nhánh rỗng (null/'') gom vào '(không có)' để vẫn đếm được, không bị mất người.
 * @returns {{name, count, children:[]}[]}
 */
function buildTree(dir) {
  if (!dir) return [];
  const c = dir.columns;
  const levels = ['division_name', 'department_name', 'section_name', 'team_name'].map((k) => c.indexOf(k));
  const root = new Map();

  for (const row of dir.rows) {
    let node = root;
    let parent = null;
    for (const li of levels) {
      const name = String(row[li] || '').trim() || '(không có)';
      if (!node.has(name)) node.set(name, { name, count: 0, children: new Map() });
      parent = node.get(name);
      parent.count++;
      node = parent.children;
    }
  }

  const toArray = (m) =>
    [...m.values()]
      .map((n) => ({ name: n.name, count: n.count, children: toArray(n.children) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'vi'));
  return toArray(root);
}

/** Danh sách giá trị duy nhất của 1 cấp (cho dropdown lọc), kèm số NV. */
function facet(dir, field) {
  if (!dir) return [];
  const i = dir.columns.indexOf(field);
  if (i < 0) return [];
  const m = new Map();
  for (const row of dir.rows) {
    const v = String(row[i] || '').trim();
    if (!v) continue;
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'vi'));
}

/**
 * Ghép org 4 cấp từ danh bạ vào các profile của roster (theo employee_id).
 * KHÔNG đụng tới các trường sẵn có — chỉ thêm dv/dept/section/team + jobtitle chuẩn.
 * NV không có trong danh bạ (đã nghỉ, hoặc danh bạ cũ) thì bỏ qua, không xoá gì.
 * @returns {number} số profile được ghép
 */
function enrich(profiles, dir) {
  if (!dir || !profiles || !profiles.length) return 0;
  const idx = indexById(dir);
  const c = dir.columns;
  const pick = {
    division: c.indexOf('division_name'),
    department: c.indexOf('department_name'),
    section: c.indexOf('section_name'),
    team: c.indexOf('team_name'),
    titleVn: c.indexOf('jobtitle_name_vn'),
    jobtitleId: c.indexOf('jobtitle_id'),
    unitId: c.indexOf('unit_id'),
  };

  let hit = 0;
  for (const p of profiles) {
    const row = idx.get(Number(p.employee_id));
    if (!row) continue;
    hit++;
    p.dw = {
      division: String(row[pick.division] || '').trim(),
      department: String(row[pick.department] || '').trim(),
      section: String(row[pick.section] || '').trim(),
      team: String(row[pick.team] || '').trim(),
      title_vn: String(row[pick.titleVn] || '').trim(),
      jobtitle_id: row[pick.jobtitleId] != null ? Number(row[pick.jobtitleId]) : null,
      unit_id: row[pick.unitId] != null ? Number(row[pick.unitId]) : null,
    };
  }
  return hit;
}

/**
 * Lọc + phân trang danh bạ phía server (dữ liệu to, đừng ném cả 22k dòng xuống trình duyệt).
 * @param {{q?:string, division?:string, department?:string, section?:string, team?:string,
 *          status?:string, page?:number, pageSize?:number}} f
 */
function search(dir, f = {}) {
  if (!dir) return { total: 0, page: 1, pageSize: 0, items: [] };
  const c = dir.columns;
  const iName = c.indexOf('employee_name');
  const iId = c.indexOf('employee_id');
  const iTitle = c.indexOf('jobtitle_name_vn');
  const iStatus = c.indexOf('status');
  const eq = (field, want) => {
    const i = c.indexOf(field);
    return i < 0 || !want ? null : { i, want: fold(String(want).trim()) };
  };
  const checks = [eq('division_name', f.division), eq('department_name', f.department),
    eq('section_name', f.section), eq('team_name', f.team)].filter(Boolean);

  const q = fold(String(f.q || '').trim());
  const wantStatus = String(f.status || '').trim();

  const out = [];
  for (const row of dir.rows) {
    if (wantStatus && String(row[iStatus]) !== wantStatus) continue;
    let ok = true;
    for (const ch of checks) {
      if (fold(String(row[ch.i] || '').trim()) !== ch.want) { ok = false; break; }
    }
    if (!ok) continue;
    if (q) {
      const hay = fold(`${row[iName]} ${row[iId]} ${row[iTitle] || ''}`);
      if (!hay.includes(q)) continue;
    }
    out.push(row);
  }

  const pageSize = Math.min(500, Math.max(1, Number(f.pageSize) || 50));
  const total = out.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(f.page) || 1));
  const start = (page - 1) * pageSize;
  return {
    total, page, pageSize, pages,
    items: out.slice(start, start + pageSize).map((r) => rowToObject(c, r)),
  };
}

module.exports = {
  buildSQL, sync, load, buildTree, facet, enrich, search, indexById, rowToObject,
  joinOrg, backfillRoster, COLUMNS, TABLE, STATUS_TEXT,
};
