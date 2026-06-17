# GTalk Campaign Studio

Bắn tin GTalk một chiều cho nhân viên GHN theo **lộ trình nội dung** + **đối tượng** (số ngày làm việc, chức danh, khối, phòng ban). Nhắm nhân viên mới (thâm niên < 2 tháng).

## Chạy

```bash
node server.js        # mở http://localhost:8090 (giao diện soạn lộ trình + chạy/gửi)
node runner.js        # chạy dòng lệnh: XEM TRƯỚC (không gửi)
node runner.js --run  # chạy dòng lệnh: GỬI THẬT
```

## Kiến trúc

- **Phần 2 — Lọc (MCP):** `lib/mcp.js` quét tool `ghn_employee_lookup` (keep-alive + song song, như app Lookup). `lib/frontier.js` dò employee_id lớn nhất. `lib/roster.js` backfill 1 lần rồi mỗi ngày chỉ quét ID mới (lưu `lastMaxId`), tự dọn người > 60 ngày.
- **Phần 1 — Bắn (GTalk):** `lib/gtalk.js` → `create-server-direct-channel` (identityId = employee_id) → `send-message`.
- **Khớp:** `lib/match.js` tính số ngày làm (ngày lịch), lọc đối tượng, render `[Tên]`/`{title}`/`{division}`/`{department}`, chống gửi trùng (`sent-log.json`).
- **runner.js** ráp tất cả; **server.js** phục vụ giao diện + API.

## Cấu hình — `data/config.json`

| khóa | ý nghĩa |
|---|---|
| `env` | `prod` hoặc `test` |
| `oaId`, `oaToken` | tài khoản OA (oaToken = `oaId:secret`) |
| `mcpApiKey` | khóa MCP gateway |
| `frontierStartGuess` | mốc bắt đầu dò biên lần đầu |
| `backfillIdSpan` | quét lùi bao nhiêu ID khi backfill (2500≈2 tuần test; **10000≈60 ngày** cho chạy thật) |
| `maxTenureDays` | cửa sổ ngày (mặc định 60) |
| `concurrency` | số luồng quét |

> Backfill lần đầu: xóa `data/roster.json` rồi chạy `node runner.js`.

## Cron hằng ngày (ví dụ 8h sáng)

```cron
0 8 * * *  cd "/Users/dollarxdustin/Documents/Bot Gtalk" && /usr/local/bin/node runner.js --run >> data/cron.log 2>&1
```
