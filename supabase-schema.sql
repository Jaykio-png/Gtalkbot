-- Chạy 1 lần trong Supabase → SQL Editor.
-- Bảng key-value lưu campaigns / roster / sent-log (server dùng service_role nên bỏ qua RLS).
create table if not exists kv (
  key   text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- Ảnh upload: tạo bucket CÔNG KHAI tên "images" ở tab Storage (hoặc chạy dòng dưới).
insert into storage.buckets (id, name, public)
values ('images', 'images', true)
on conflict (id) do nothing;
