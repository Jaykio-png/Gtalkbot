/**
 * Client cho GHN Data API Query (Trino qua HTTP token) — không dependency ngoài.
 *
 *   POST   /api/v1/queries            → { queryId, status, schema?, rows, hasMore }  (submit, CHƯA có data)
 *   GET    /api/v1/queries/{id}/next  → batch tiếp; lặp tới khi hasMore=false
 *   DELETE /api/v1/queries/{id}       → hủy (best effort)
 *
 * Ba điều dễ sai, đã xử ở đây:
 *  1) Tín hiệu dừng là `hasMore`, KHÔNG phải `status`. Submit trả status FINISHED nhưng rows vẫn rỗng.
 *  2) rows:[] mà hasMore:true là BÌNH THƯỜNG (query đang tính) → chờ rồi /next tiếp, đừng tight-loop
 *     (tight-loop vừa vô ích vừa dễ ăn 429), cũng đừng nghỉ quá lâu (410 query_expired).
 *  3) Bỏ dở giữa chừng làm treo query phía warehouse → luôn drain hết hoặc DELETE.
 *
 * Quota tính theo POST /queries (1 query = 1 lượt, drain bao nhiêu batch cũng không tính thêm)
 * → gộp nhiều thứ vào 1 câu SQL luôn rẻ hơn chia nhỏ. Token dev hiện có 50 lượt/ngày.
 */
const https = require('https');

const DEFAULT_HOST = 'https://data-api-provider.ghn.vn';

// data-api-provider.ghn.vn có HAI bản ghi A: 10.139.0.22 (nội bộ) và 35.230.66.9 (công cộng).
// Ngoài mạng nội bộ thì IP 10.x câm — mà dns.lookup() lại hay trả đúng IP đó trước.
// autoSelectFamily = đua song song cả hai, xài cái nào bắt tay xong trước (Happy Eyeballs).
// Node ≥20 bật sẵn, nhưng package.json khai engines ">=18" và Node 18 KHÔNG bật —
// ở đó mọi request sẽ treo tới hết timeout. Nên bật tường minh, đừng dựa vào mặc định.
const agent = new https.Agent({ keepAlive: true, maxSockets: 4, autoSelectFamily: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Gọi 1 request, trả { status, headers, json, raw }. Không tự retry (để tầng trên quyết). */
function request(method, urlStr, token, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        agent,
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          // Gom Buffer rồi decode UTF-8 1 lần — tên NV tiếng Việt hay bị cắt ngang giữa 2 mảnh
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { /* body không phải JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, json, raw });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Data API timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Lỗi có mã của Data API — giữ nguyên code/httpStatus để tầng trên hiển thị cho đúng. */
class DapError extends Error {
  constructor(message, code, httpStatus, queryId) {
    super(message);
    this.name = 'DapError';
    this.code = code || 'unknown';
    this.httpStatus = httpStatus || 0;
    this.queryId = queryId || null;
  }
}

/** Bóc { error: { code, message } } của Data API thành DapError. */
function toError(r, fallbackMsg) {
  const e = r.json && r.json.error;
  const code = (e && e.code) || (r.status === 401 ? 'unauthorized' : 'http_' + r.status);
  const msg = (e && e.message) || fallbackMsg || (r.raw || '').slice(0, 200) || 'HTTP ' + r.status;
  return new DapError(msg, code, r.status, e && e.queryId);
}

/** Thông điệp tiếng Việt cho các mã lỗi hay gặp (hiện thẳng lên UI). */
const FRIENDLY = {
  unauthorized: 'Token sai / đã bị thu hồi hoặc hết hạn — xin Data team cấp lại.',
  forbidden: 'Token không có quyền đọc bảng này — xin Data team mở quyền.',
  read_only: 'Chỉ chạy được câu đọc (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN/VALUES).',
  quota_exceeded: 'Hết quota hôm nay (reset 07:00 giờ VN) — xin Data team top-up nếu cần gấp.',
  rate_limited: 'Bị giới hạn tốc độ (30 req/giây) — thử lại sau giây lát.',
  query_expired: 'Query hết hạn do nghỉ quá lâu giữa 2 lần lấy batch — chạy lại.',
  cancelled: 'Query đã bị hủy.',
  not_found: 'Query không tồn tại hoặc đã kết thúc — chạy lại.',
};
const friendly = (err) => FRIENDLY[err.code] || err.message;

class DapClient {
  /**
   * @param {string} token  token dap_xxx (đọc từ env DATA_API_TOKEN, đừng hardcode)
   * @param {{host?:string}} opts
   */
  constructor(token, { host } = {}) {
    this.token = String(token || '').trim();
    this.host = String(host || DEFAULT_HOST).replace(/\/+$/, '');
    this.quotaRemaining = null; // cập nhật sau mỗi lần submit (header X-Quota-Remaining)
  }

  get configured() { return !!this.token; }

  /**
   * Chạy 1 câu SQL, drain hết batch, trả { columns, rows, stats, queryId }.
   * rows là mảng-các-mảng theo thứ tự columns (đúng như API trả).
   *
   * @param {string} sql
   * @param {{onProgress?:(n:number)=>void, maxRows?:number, signal?:{aborted:boolean}}} opts
   *        onProgress(soDongDaLay) — gọi sau mỗi batch có data.
   *        maxRows — trần an toàn, vượt thì DELETE query rồi dừng (tránh ôm cả bảng vào RAM).
   *        signal.aborted — bật true để hủy giữa chừng.
   */
  async query(sql, { onProgress, maxRows = 200000, signal } = {}) {
    if (!this.configured) throw new DapError('Chưa cấu hình DATA_API_TOKEN.', 'no_token', 0);

    // --- 1) Submit. 429/503 ở bước này retry được vì query chưa hề chạy. ---
    let sub = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const r = await request('POST', `${this.host}/api/v1/queries`, this.token, { sql });
      const q = r.headers && r.headers['x-quota-remaining'];
      if (q != null) this.quotaRemaining = Number(q);
      if (r.status === 200 && r.json && r.json.queryId) { sub = r.json; break; }

      const err = toError(r, 'Submit thất bại');
      // Hết quota / sai token / SQL lỗi → retry vô ích, ném luôn
      if (err.code === 'quota_exceeded' || r.status === 401 || r.status === 403 || r.status === 400) throw err;
      if (attempt === 4) throw err;
      await sleep(500 * attempt);
    }

    const queryId = sub.queryId;
    const columns = (sub.schema || []).map((c) => c.name);
    const rows = sub.rows ? sub.rows.slice() : [];
    let stats = sub.stats || null;
    let hasMore = sub.hasMore !== false;
    let idle = 0; // số batch liên tiếp rỗng → giãn dần thời gian chờ

    // --- 2) Drain tới khi hasMore=false. Dừng theo hasMore, KHÔNG theo status. ---
    try {
      while (hasMore) {
        if (signal && signal.aborted) throw new DapError('Đã hủy theo yêu cầu.', 'aborted', 0, queryId);
        if (rows.length > maxRows) throw new DapError(`Vượt trần ${maxRows} dòng — thu hẹp câu SQL lại.`, 'too_many_rows', 0, queryId);

        const r = await this._next(queryId);
        if (r.schema && columns.length === 0) for (const c of r.schema) columns.push(c.name);
        const batch = r.rows || [];
        if (batch.length) {
          for (const row of batch) rows.push(row);
          idle = 0;
          if (onProgress) onProgress(rows.length);
        } else {
          idle++;
        }
        if (r.stats) stats = r.stats;
        hasMore = r.hasMore !== false;

        // Batch rỗng = query đang tính. Chờ tăng dần 1s→8s: đủ chậm để không spam,
        // đủ nhanh để không chạm query_expired.
        if (hasMore && batch.length === 0) await sleep(Math.min(8000, 1000 * idle));
      }
    } catch (e) {
      // Bỏ dở → hủy để warehouse nhả tài nguyên (best effort, nuốt lỗi)
      if (!(e instanceof DapError) || (e.code !== 'query_expired' && e.code !== 'cancelled' && e.code !== 'not_found')) {
        try { await this.cancel(queryId); } catch { /* kệ */ }
      }
      throw e;
    }

    return { columns, rows, stats, queryId };
  }

  /**
   * Lấy 1 batch, có retry cho các lỗi TẠM THỜI.
   * An toàn vì cursor chỉ tiến khi server trả 200 → retry không skip/trùng dòng.
   */
  async _next(queryId) {
    let wait = 100;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const r = await request('GET', `${this.host}/api/v1/queries/${queryId}/next`, this.token);
      if (r.status === 200 && r.json) return r.json;

      const err = toError(r, 'Lấy batch thất bại');
      // 503 pod_busy / 502 trino_error / 429 rate_limited / 409 conflict → chờ rồi gọi LẠI đúng /next đó
      const retryable = r.status === 503 || r.status === 502 || r.status === 409 || err.code === 'rate_limited';
      if (!retryable || attempt === 6) throw err;
      await sleep(wait);
      wait = Math.min(3000, wait * 2);
    }
    throw new DapError('Lấy batch thất bại sau nhiều lần thử.', 'next_failed', 0, queryId);
  }

  /**
   * Kiểm tra "có gọi tới được không" mà KHÔNG tốn quota (quota chỉ tính ở POST /queries).
   * Gọi /next lên 1 queryId không tồn tại: mạng thông + token đúng → 404 not_found.
   * @returns {{reachable:boolean, authorized:boolean, httpStatus:number, ms:number, detail:string}}
   */
  async ping() {
    const t0 = Date.now();
    try {
      const r = await request('GET', `${this.host}/api/v1/queries/ping-not-a-real-query/next`, this.token);
      const ms = Date.now() - t0;
      // Tới được server là reachable, kể cả khi nó chửi 404/401.
      const authorized = r.status !== 401 && r.status !== 403;
      const detail = r.status === 404 ? 'OK — mạng thông, token hợp lệ.'
        : r.status === 401 ? 'Tới được server nhưng token sai/hết hạn.'
        : r.status === 403 ? 'Tới được server nhưng token không đủ quyền.'
        : `Tới được server (HTTP ${r.status}).`;
      return { reachable: true, authorized, httpStatus: r.status, ms, detail };
    } catch (e) {
      return {
        reachable: false, authorized: false, httpStatus: 0, ms: Date.now() - t0,
        detail: `Không gọi tới được ${this.host} — ${e.message}.`,
      };
    }
  }

  /** Hủy query (best effort). */
  async cancel(queryId) {
    const r = await request('DELETE', `${this.host}/api/v1/queries/${queryId}`, this.token);
    return r.status < 300;
  }

  /** Đổi { columns, rows } → mảng object, tiện dùng tiếp. */
  static toObjects({ columns, rows }) {
    return rows.map((r) => {
      const o = {};
      for (let i = 0; i < columns.length; i++) o[columns[i]] = r[i];
      return o;
    });
  }
}

module.exports = { DapClient, DapError, friendly, DEFAULT_HOST };
