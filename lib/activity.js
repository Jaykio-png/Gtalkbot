/**
 * Nhật ký hoạt động của Bot theo NGÀY (giờ VN): mỗi lần gửi ghi lại "gửi cho ai / nội dung gì".
 *
 * - Lưu trong store (Supabase kv 'activity' hoặc data/activity-log.json), shape: { 'YYYY-MM-DD': [entry,...] }.
 * - TỰ GIỮ 2 NGÀY (hôm nay + hôm qua) rồi tự xoá ngày cũ hơn cho nhẹ. Prune chạy mỗi lần ghi + mỗi lần đọc.
 *
 * entry = { at, employee_id, name, title, source:'campaign'|'blast', campaign, day,
 *           text, image:bool, imageUrl, parseMode, status:'ok'|'error'|'skip'|'notfound', error }
 */
const store = require('./store');

const VN_OFFSET_MS = 7 * 3600 * 1000;
const RETENTION_DAYS = 2; // giữ hôm nay + hôm qua

/** 'YYYY-MM-DD' theo giờ VN cho thời điểm now. */
function vnDateStr(now = new Date()) {
  return new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Ngày biên (giữ các ngày >= cutoff, xoá ngày < cutoff). */
function cutoffDateStr(now = new Date()) {
  const d = new Date(now.getTime() + VN_OFFSET_MS);
  d.setUTCDate(d.getUTCDate() - (RETENTION_DAYS - 1));
  return d.toISOString().slice(0, 10);
}

/** Xoá các ngày cũ hơn cutoff khỏi log (mutate). Trả số ngày đã xoá. */
function prune(log, now = new Date()) {
  const cutoff = cutoffDateStr(now);
  let removed = 0;
  for (const date of Object.keys(log)) {
    // Khoá là 'YYYY-MM-DD' nên so chuỗi = so ngày. Bỏ mọi khoá lạ (không đúng dạng ngày).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < cutoff) { delete log[date]; removed++; }
  }
  return removed;
}

/** Ghi một mẻ entry vào nhật ký của HÔM NAY (giờ VN) + tự dọn ngày cũ. Bỏ qua nếu rỗng. */
async function logSends(entries, now = new Date()) {
  const list = (entries || []).filter(Boolean);
  if (!list.length) return;
  const today = vnDateStr(now);
  const log = (await store.getActivity()) || {};
  if (!Array.isArray(log[today])) log[today] = [];
  log[today].push(...list);
  prune(log, now);
  await store.setActivity(log);
}

/** Tạo entry từ 1 "send" của lộ trình (runner.run). */
function fromCampaignSend(s, now, status, error = '') {
  return {
    at: now.toISOString(),
    employee_id: s.employee.employee_id,
    name: s.employee.full_name || '',
    title: s.employee.title_name || '',
    source: 'campaign',
    campaign: s.campaignName || '',
    day: s.day,
    text: s.text || '',
    image: !!s.imageUrl,
    imageUrl: s.imageUrl || '',
    parseMode: s.parseMode || 'PLAIN_TEXT',
    status,
    error: error || '',
  };
}

/** Tạo entry từ 1 item của bắn nhanh/blast (runner.quickSend). */
function fromBlastItem(it, ctx, now) {
  return {
    at: now.toISOString(),
    employee_id: it.employee_id,
    name: it.full_name || '',
    title: it.title_name || '',
    source: 'blast',
    campaign: '',
    day: null,
    text: it.text || '',
    image: !!ctx.imageUrl,
    imageUrl: ctx.imageUrl || '',
    parseMode: ctx.parseMode || 'PLAIN_TEXT',
    status: it.status || 'ok',
    error: it.error || '',
  };
}

const summarize = (entries) => ({
  total: entries.length,
  ok: entries.filter((e) => e.status === 'ok').length,
  error: entries.filter((e) => e.status === 'error' || e.status === 'notfound').length,
});

/** Danh sách ngày còn giữ (mới → cũ) kèm tổng/ok/lỗi. Dọn ngày cũ luôn nếu có. */
async function listDates(now = new Date()) {
  const log = (await store.getActivity()) || {};
  if (prune(log, now)) { try { await store.setActivity(log); } catch { /* đọc vẫn trả được */ } }
  const dates = Object.keys(log)
    .sort().reverse()
    .map((date) => ({ date, ...summarize(log[date] || []) }));
  return { today: vnDateStr(now), dates };
}

/** Chi tiết 1 ngày (mặc định hôm nay). Trả entry MỚI NHẤT trước. */
async function getDay(date, now = new Date()) {
  const log = (await store.getActivity()) || {};
  const d = date || vnDateStr(now);
  const entries = Array.isArray(log[d]) ? log[d].slice().reverse() : [];
  return { date: d, entries, summary: summarize(entries) };
}

/** Xoá thủ công 1 ngày (hoặc tất cả nếu không truyền date). Trả số entry đã xoá. */
async function clearDay(date, now = new Date()) {
  const log = (await store.getActivity()) || {};
  let removed = 0;
  if (date) { removed = (log[date] || []).length; delete log[date]; }
  else { for (const k of Object.keys(log)) removed += (log[k] || []).length; for (const k of Object.keys(log)) delete log[k]; }
  await store.setActivity(log);
  return removed;
}

module.exports = { logSends, fromCampaignSend, fromBlastItem, listDates, getDay, clearDay, prune, vnDateStr };
