/** Kiểm tra nhanh: môi trường này có gọi được GHN gateway không (qua Cloudflare). */
const { McpClient } = require('./lib/mcp');

(async () => {
  const key = (process.env.MCP_API_KEY || '').replace(/[^\x21-\x7e]/g, '');
  if (!key) { console.error('✗ Thiếu MCP_API_KEY'); process.exit(1); }
  const mcp = new McpClient(key);
  try {
    const info = await mcp.connect();
    console.log('✓ GHN GATEWAY REACHABLE — server:', JSON.stringify(info));
    const r = await mcp.lookup(3099224, true);
    console.log('✓ lookup OK — found:', r?.found, '| name:', r?.profile?.full_name);
    console.log('\n==> KẾT LUẬN: Môi trường này GỌI ĐƯỢC GHN.');
    process.exit(0);
  } catch (e) {
    const msg = String(e.message || e);
    const blocked = /just a moment|cloudflare|<!doctype/i.test(msg);
    console.error('✗ THẤT BẠI:', msg.slice(0, 200));
    console.error('\n==> KẾT LUẬN: ' + (blocked ? 'BỊ CLOUDFLARE CHẶN (IP môi trường này bị chặn).' : 'Lỗi khác.'));
    process.exit(1);
  }
})();
