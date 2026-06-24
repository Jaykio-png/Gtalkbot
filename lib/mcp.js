/**
 * MCP client (server-side) — cùng cách quét như app Lookup:
 *   keep-alive + nhiều luồng song song + parse SSE.
 * Tool: ghn_employee_lookup
 */
const https = require('https');

const EP = 'https://ws-mcpgateway.ghn.vn/mcp';
const PROTOCOL_VERSION = '2025-06-18';

// Keep-alive agent => tái dùng kết nối TLS, tránh bắt tay lại mỗi lượt (đây là
// lý do quét bằng curl rời rạc rất chậm, còn trình duyệt/agent thì nhanh).
const agent = new https.Agent({ keepAlive: true, maxSockets: 10 });

function rawPost(apiKey, sessionId, bodyObj) {
  return new Promise((resolve, reject) => {
    const url = new URL(EP);
    const payload = JSON.stringify(bodyObj);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': apiKey,
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        // Gom Buffer rồi decode UTF-8 1 lần — tránh hỏng ký tự tiếng Việt khi bị cắt ngang giữa 2 mảnh
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ sessionId: res.headers['mcp-session-id'], status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('MCP request timeout')));
    req.write(payload);
    req.end();
  });
}

function parseSSE(text) {
  for (const line of String(text).split('\n')) {
    if (line.startsWith('data: ')) {
      try { return JSON.parse(line.slice(6)); } catch { /* ignore */ }
    }
  }
  try { return JSON.parse(text); } catch { return null; }
}

class McpClient {
  /** @param {string} apiKey @param {{minIntervalMs?:number}} opts giãn cách tối thiểu giữa 2 call (chống rate limit) */
  constructor(apiKey, { minIntervalMs = 400 } = {}) {
    this.apiKey = apiKey;
    this.sessionId = null;
    this._id = 1; // bộ đếm json-rpc id duy nhất (tránh trả lệch khi gọi song song)
    this._minInterval = Math.max(0, minIntervalMs); // ms giữa các lần gọi API
    this._nextSlot = 0;                              // mốc thời gian được phép gọi tiếp
  }

  /** Giãn cách các lần gọi để không vượt rate limit (đặt chỗ slot kế tiếp, atomic vì JS đơn luồng). */
  async _throttle() {
    if (!this._minInterval) return;
    const now = Date.now();
    const slot = Math.max(now, this._nextSlot);
    this._nextSlot = slot + this._minInterval;
    const wait = slot - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async connect() {
    const r = await rawPost(this.apiKey, null, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'gtalk-campaign-studio', version: '1.0.0' } },
    });
    if (r.sessionId) this.sessionId = r.sessionId;
    const init = parseSSE(r.text);
    if (!init?.result?.serverInfo) throw new Error('MCP initialize failed: ' + r.text.slice(0, 200));
    await rawPost(this.apiKey, this.sessionId, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    return init.result.serverInfo;
  }

  /**
   * Tra 1 nhân viên. Trả { found, profile } (kể cả found:false) hoặc null nếu không rõ.
   * Có kết quả rõ ràng (có/không có) -> trả NGAY (1 call). Bị rate-limit/lỗi tạm (rỗng) -> thử lại,
   * tối đa `retries` lần (mặc định 3) với backoff — để KHÔNG miss người thật. _throttle() đã giãn cách sẵn.
   */
  async lookup(employeeId, includeOff = true, retries = 3) {
    const tries = Math.max(1, retries);
    for (let attempt = 1; attempt <= tries; attempt++) {
      await this._throttle(); // giãn cách chống rate limit (kể cả khi gọi song song)
      try {
        const r = await rawPost(this.apiKey, this.sessionId, {
          jsonrpc: '2.0', id: ++this._id, method: 'tools/call',
          params: { name: 'ghn_employee_lookup', arguments: { employee_id: Number(employeeId), include_off: includeOff } },
        });
        const d = parseSSE(r.text);
        const sc = d?.result?.structuredContent;
        if (sc && typeof sc.found === 'boolean') return sc; // kết quả rõ ràng (kể cả không tìm thấy) -> dừng, 1 call
        const txt = d?.result?.content?.find((c) => c.type === 'text')?.text;
        if (txt) { try { return JSON.parse(txt); } catch { /* parse lỗi */ } }
      } catch { /* lỗi mạng */ }
      if (attempt < tries) await new Promise((res) => setTimeout(res, 300 * attempt));
    }
    return null; // không có kết quả rõ -> pass
  }

  /** Quét dải [from..to] với `concurrency` luồng. onProgress(done,total,found). */
  async scanRange(from, to, { concurrency = 5, includeOff = true, onProgress } = {}) {
    const ids = [];
    for (let i = from; i <= to; i++) ids.push(i);
    const total = ids.length;
    const found = [];
    let done = 0, idx = 0;

    const worker = async () => {
      while (idx < ids.length) {
        const id = ids[idx++];
        try {
          const res = await this.lookup(id, includeOff);
          if (res?.found && res.profile) found.push(res.profile);
        } catch { /* bỏ qua ID lỗi */ }
        done++;
        if (onProgress) onProgress(done, total, found.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    return found;
  }
}

module.exports = { McpClient };
