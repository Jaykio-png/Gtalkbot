/** Theo dõi tiến độ các lượt gửi hàng loạt (trong bộ nhớ, để UI poll). */
const jobs = new Map();

function newId() { return 'job_' + Date.now() + '_' + Math.floor(Math.random() * 1e6); }

function create(total) {
  const id = newId();
  jobs.set(id, {
    id, total, done: 0, ok: 0, failed: 0, skipped: 0,
    status: 'running', current: '', error: null,
    items: [], startedAt: Date.now(), finishedAt: null,
  });
  // dọn job cũ > 2 giờ
  const now = Date.now();
  for (const [k, j] of jobs) if (now - j.startedAt > 2 * 3600 * 1000) jobs.delete(k);
  return id;
}

function get(id) { return jobs.get(id) || null; }
function update(id, fn) { const j = jobs.get(id); if (j) fn(j); }

module.exports = { create, get, update };
