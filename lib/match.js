/**
 * Logic khớp: nhân viên + lộ trình -> danh sách tin cần gửi hôm nay.
 * - Số ngày làm việc = số ngày LỊCH kể từ start_working_date (giống app Lookup).
 * - Lọc đối tượng theo: chức danh, khối, phòng ban, trạng thái.
 * - Mỗi mốc (day) chỉ gửi 1 lần / nhân viên / lộ trình (dựa vào sent-log).
 */

const DAY_MS = 86400000;
const EMPTY_DATE = '0001-01-01T00:00:00Z';

function isActive(p) {
  return p.status === 1 || (p.status_text || '').toLowerCase().includes('working') || (p.status_text || '').includes('đang làm');
}

function workingDays(p, now = new Date()) {
  const start = new Date(p.start_working_date);
  if (isNaN(start.getTime())) return null;
  const hasLeave = p.leave_date && p.leave_date !== '' && p.leave_date !== EMPTY_DATE;
  const end = hasLeave ? new Date(p.leave_date) : now;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** Tách org "X Division / Y Department" -> { division, department }. */
function parseOrg(org) {
  const parts = String(org || '').split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { division: '', department: '' };
  if (parts.length === 1) return { division: parts[0], department: '' };
  // phần đầu = khối, phần cuối = phòng ban (org có thể nhiều cấp)
  return { division: parts[0], department: parts[parts.length - 1] };
}

function normalize(s) { return String(s || '').trim().toLowerCase(); }

/** Một nhân viên có khớp bộ lọc đối tượng của lộ trình không? */
function matchesAudience(profile, audience = {}) {
  if (!audience.includeOff && !isActive(profile)) return false;

  const { division, department } = parseOrg(profile.org);
  const title = profile.title_name || '';

  const inList = (val, list) => {
    if (!list || list.length === 0) return true; // rỗng = tất cả
    return list.map(normalize).includes(normalize(val));
  };

  if (!inList(title, audience.titles)) return false;
  if (!inList(division, audience.divisions)) return false;
  if (!inList(department, audience.departments)) return false;
  return true;
}

/** Thay [Tên]/{name}... bằng dữ liệu thật. */
function renderMessage(text, profile) {
  const { division, department } = parseOrg(profile.org);
  const map = {
    '[Tên]': profile.full_name || '',
    '[tên]': profile.full_name || '',
    '{name}': profile.full_name || '',
    '{full_name}': profile.full_name || '',
    '{title}': profile.title_name || '',
    '{division}': division,
    '{department}': department,
    '{employee_id}': String(profile.employee_id || ''),
    '{days}': String(workingDays(profile) ?? ''),
  };
  let out = String(text || '');
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  return out;
}

function sentKey(employeeId, campaignId, day) {
  return `${employeeId}|${campaignId}|${day}`;
}

/**
 * "Ngày" của nhân viên trong 1 lộ trình:
 *  - anchorMode 'campaign': số ngày kể từ startDate (startDate = ngày 1).
 *  - mặc định 'tenure': số ngày làm việc (thâm niên).
 */
function campaignDay(camp, profile, now = new Date()) {
  if (camp.anchorMode === 'campaign') {
    if (!camp.startDate) return null;
    const s = new Date(camp.startDate);
    if (isNaN(s.getTime())) return null;
    const a = Date.UTC(s.getFullYear(), s.getMonth(), s.getDate());
    const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor((b - a) / DAY_MS) + 1; // ngày bắt đầu = 1
  }
  return workingDays(profile, now);
}

/**
 * Tính danh sách tin cần gửi hôm nay.
 * @param {Array} employees  profiles từ MCP
 * @param {Array} campaigns  lộ trình
 * @param {Object} sentLog   { key: timestamp } các tin đã gửi
 * @returns {Array<{employee, campaignId, campaignName, day, text}>}
 */
function computeSends(rosterActive, campaigns, sentLog = {}, now = new Date(), profilesById = {}) {
  const sends = [];
  for (const camp of campaigns) {
    if (camp.enabled === false) continue;
    const messages = (camp.messages || []).filter((m) => m && Number.isFinite(Number(m.day)));
    if (messages.length === 0) continue;

    // Đối tượng: nếu có targetIds -> đúng những người đó; ngược lại -> roster (NV mới)
    const ids = (camp.targetIds || []).map(Number).filter(Number.isFinite);
    const population = ids.length ? ids.map((id) => profilesById[id]).filter(Boolean) : rosterActive;

    for (const p of population) {
      if (!matchesAudience(p, camp.audience)) continue;
      const day = campaignDay(camp, p, now);
      if (day == null) continue;

      for (const m of messages) {
        if (Number(m.day) !== day) continue;
        const key = sentKey(p.employee_id, camp.id, m.day);
        if (sentLog[key]) continue; // đã gửi rồi
        sends.push({
          employee: p, campaignId: camp.id, campaignName: camp.name, day: Number(m.day),
          text: renderMessage(m.text, p), key,
          parseMode: camp.parseMode || 'PLAIN_TEXT',
          imageUrl: (m.imageUrl || '').trim() || null,
        });
      }
    }
  }
  return sends;
}

module.exports = { workingDays, campaignDay, parseOrg, isActive, matchesAudience, renderMessage, computeSends, sentKey };
