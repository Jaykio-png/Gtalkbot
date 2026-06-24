/**
 * Scheduler nội bộ (zero-dep) — đặt lịch CRAWL (chung) và GỬI (giờ RIÊNG từng lộ trình) ngay trong server.
 *
 * Cách hoạt động: cứ 30s so giờ hiện tại (giờ VN = UTC+7) với:
 *   - crawlTime (chung) trong lịch tổng.
 *   - sendTime của TỪNG lộ trình (campaign.sendTime) — mỗi lộ trình bắn theo giờ riêng.
 * Trùng phút + chưa chạy trong ngày -> kích hoạt (1 lần/ngày/việc).
 *
 * ⚠️ Chỉ đáng tin khi server chạy LIÊN TỤC (VPS/máy 24/7).
 *
 * Lịch crawl chung (store 'schedule'): { crawlEnabled, crawlTime:'HH:MM' }.
 * Tự-gửi không có công tắc tổng: lộ trình nào đang BẬT và có sendTime thì tự gửi đúng giờ đó.
 */
const store = require('./store');

const VN_OFFSET_MS = 7 * 3600 * 1000;
const vnNow = () => new Date(Date.now() + VN_OFFSET_MS);
const vnDateStr = (d) => d.toISOString().slice(0, 10);   // YYYY-MM-DD (đã +7)
const vnHHMM = (d) => d.toISOString().slice(11, 16);     // HH:MM (đã +7)

let cfg = null;            // lịch tổng (cache RAM)
let campaigns = [];        // danh sách lộ trình (cache RAM, cập nhật khi lưu)
let deps = null;           // { log, runCrawl, runSend(campaignId) }
let timer = null;
const lastRun = {};        // khóa 'crawl' | 'send:<id>' -> 'YYYY-MM-DD' đã chạy (chống chạy lặp trong ngày)

async function tick() {
  if (!cfg || !deps) return;
  const d = vnNow();
  const today = vnDateStr(d);
  const hhmm = vnHHMM(d);

  // 1) CRAWL — giờ chung
  if (cfg.crawlEnabled && cfg.crawlTime === hhmm && lastRun.crawl !== today) {
    lastRun.crawl = today;
    deps.log(`[scheduler] ${hhmm} VN → kích hoạt CRAWL`);
    Promise.resolve().then(() => deps.runCrawl()).catch((e) => deps.log('[scheduler] crawl lỗi: ' + e.message));
  }

  // 2) GỬI — mỗi lộ trình tự gửi theo GIỜ RIÊNG của nó (đang bật + có sendTime + trùng phút)
  for (const c of campaigns) {
    if (c.enabled === false) continue;
    if (!c.sendTime || c.sendTime !== hhmm) continue;
    const key = 'send:' + c.id;
    if (lastRun[key] === today) continue;
    lastRun[key] = today;
    deps.log(`[scheduler] ${hhmm} VN → gửi lộ trình "${c.name || c.id}"`);
    Promise.resolve().then(() => deps.runSend(c.id)).catch((e) => deps.log(`[scheduler] gửi "${c.name || c.id}" lỗi: ` + e.message));
  }
}

/** Cập nhật lịch tổng trong RAM (gọi sau khi lưu store). */
function setSchedule(s) { cfg = s; }
/** Cập nhật danh sách lộ trình trong RAM (gọi sau khi lưu campaigns). */
function setCampaigns(list) { campaigns = Array.isArray(list) ? list : []; }

/** Bật scheduler. deps = { log, runCrawl():Promise, runSend(campaignId):Promise }. */
async function start(d) {
  deps = d;
  try { cfg = await store.getSchedule(); } catch { cfg = null; }
  try { campaigns = await store.getCampaigns(); } catch { campaigns = []; }
  if (!timer) timer = setInterval(tick, 30000);
  const c = cfg || {};
  const times = (campaigns || []).filter((x) => x.enabled !== false && x.sendTime).map((x) => `${x.name || x.id}@${x.sendTime}`);
  deps.log(`[scheduler] đã bật (giờ VN) — crawl=${c.crawlEnabled ? c.crawlTime : 'tắt'}, lộ trình tự gửi: ${times.length ? times.join(', ') : 'không có'}`);
}

module.exports = { start, setSchedule, setCampaigns };
