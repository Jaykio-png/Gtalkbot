# Deploy miễn phí (Supabase + Render + GitHub Actions)

Kiến trúc: **Render** chạy giao diện/API · **Supabase** lưu dữ liệu + ảnh · **GitHub Actions** gửi tin tự động mỗi ngày.

## 1) Supabase (lưu trữ)
1. Tạo project tại supabase.com (free).
2. Vào **SQL Editor** → dán nội dung `supabase-schema.sql` → Run (tạo bảng `kv` + bucket `images`).
3. Vào **Storage** → kiểm tra bucket **images** là **Public** (nếu chưa, sửa thành public).
4. Vào **Project Settings → API**, lấy:
   - **Project URL** → biến `SUPABASE_URL`
   - **service_role key** (secret) → biến `SUPABASE_KEY`

## 2) GitHub (mã nguồn + cron)
1. Tạo repo (private), push toàn bộ thư mục này lên. *(File trong `.gitignore` như `data/`, secrets sẽ không bị đẩy lên — đúng ý.)*
2. Vào **Settings → Secrets and variables → Actions → New repository secret**, thêm:
   `SUPABASE_URL`, `SUPABASE_KEY`, `OA_ID`, `OA_TOKEN`, `MCP_API_KEY`.
3. Workflow `.github/workflows/daily-send.yml` sẽ tự chạy **08:00 sáng VN** mỗi ngày. Muốn chạy thử: tab **Actions → Gửi tin hằng ngày → Run workflow**.
   - Lần chạy ĐẦU sẽ **backfill** roster (~10–25 phút, GitHub Actions cho phép tới 60 phút) — bình thường. Các lần sau chỉ quét ID mới → nhanh.

## 3) Render (giao diện)
1. render.com → **New → Blueprint** → trỏ tới repo (đọc `render.yaml`). *(Hoặc New → Web Service, Start command: `node server.js`.)*
2. Nhập các biến môi trường (Environment):
   - `SUPABASE_URL`, `SUPABASE_KEY` (như trên)
   - `OA_ID`, `OA_TOKEN`, `MCP_API_KEY`
   - `GTALK_ENV` = `prod`
   - `AUTH_USER`, `AUTH_PASS` = tài khoản/mật khẩu đăng nhập web (tự đặt)
3. Deploy → mở link Render → đăng nhập bằng AUTH_USER/AUTH_PASS.
   > Gói free sẽ "ngủ" khi rảnh — lần mở đầu chờ ~30s là tỉnh.

## Biến môi trường (tóm tắt)
| Biến | Dùng ở | Ý nghĩa |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_KEY` | Render + Actions | Kết nối Supabase (service_role) |
| `SUPABASE_BUCKET` | (mặc định `images`) | Bucket ảnh |
| `OA_ID`, `OA_TOKEN` | Render + Actions | Tài khoản OA GTalk |
| `MCP_API_KEY` | Render + Actions | Khóa MCP gateway |
| `GTALK_ENV` | (mặc định `prod`) | prod/test |
| `AUTH_USER`, `AUTH_PASS` | Render | Đăng nhập web |
| `BACKFILL_ID_SPAN`, `MAX_TENURE_DAYS`, `CONCURRENCY` | tùy chọn | Tinh chỉnh quét |

## Chạy thử local (không cần Supabase)
Không đặt biến `SUPABASE_*` → app tự dùng file `data/*.json`. `node server.js` rồi mở http://localhost:8090.
