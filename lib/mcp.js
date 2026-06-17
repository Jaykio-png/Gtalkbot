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
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ sessionId: res.headers['mcp-session-id'], status: res.statusCode, text: data })
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
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.sessionId = null;
    this._id = 1; // bộ đếm json-rpc id duy nhất (tránh trả lệch khi gọi song song)
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

  /** Tra 1 nhân viên. Trả { found, profile } hoặc null nếu lỗi. */
  async lookup(employeeId, includeOff = true) {
    // tự thử lại tối đa 3 lần khi gateway lỗi tạm (tránh bỏ sót người thật)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await rawPost(this.apiKey, this.sessionId, {
          jsonrpc: '2.0', id: ++this._id, method: 'tools/call',
          params: { name: 'ghn_employee_lookup', arguments: { employee_id: Number(employeeId), include_off: includeOff } },
        });
        const d = parseSSE(r.text);
        const sc = d?.result?.structuredContent;
        if (sc && typeof sc.found === 'boolean') return sc; // kết quả hợp lệ (kể cả found:false)
        const txt = d?.result?.content?.find((c) => c.type === 'text')?.text;
        if (txt) { try { return JSON.parse(txt); } catch { /* parse lỗi -> thử lại */ } }
      } catch { /* lỗi mạng -> thử lại */ }
      if (attempt < 3) await new Promise((res) => setTimeout(res, 300 * attempt));
    }
    return null;
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
