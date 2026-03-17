# Hướng dẫn cài đặt Encode Worker (AX41-NVME)

## Yêu cầu
- Server Ubuntu 22.04 LTS (VD: Hetzner AX41-NVME)
- App server đang chạy và có IP public
- Repo code đã có thư mục `worker/`

---

## Bước 1 — Cài môi trường trên server worker

SSH vào server rồi chạy:

```bash
apt update && apt upgrade -y

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git ffmpeg

node -v && ffmpeg -version   # kiểm tra
```

---

## Bước 2 — Upload code worker

Từ máy Windows local:

```powershell
scp -r d:/nodejs/worker root@<WORKER_IP>:/opt/hls-worker
```

---

## Bước 3 — Cài dependencies

```bash
cd /opt/hls-worker
npm install
```

---

## Bước 4 — Tạo file `.env`

```bash
nano /opt/hls-worker/.env
```

Điền nội dung:

```env
WORKER_PORT=4000
WORKER_TOKEN=<token-bí-mật>
APP_URL=http://<APP_SERVER_IP>:3000
HLS_OUTPUT_DIR=/tmp/hls-encode
UPLOAD_DIR=/tmp/uploads
```

> **Tạo token ngẫu nhiên:**
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```
> Copy chuỗi đó làm `WORKER_TOKEN`. Phải **giống nhau** trên cả worker và app server.

---

## Bước 5 — Chạy bằng PM2

```bash
npm install -g pm2
cd /opt/hls-worker
pm2 start server.js --name hls-worker
pm2 save && pm2 startup
```

---

## Bước 6 — Cấu hình App Server

Thêm vào `.env` trên app server:

```env
WORKER_URLS=http://<WORKER_IP>:4000
WORKER_TOKEN=<token-bí-mật>   # giống token ở trên
```

Restart app server sau khi sửa `.env`.

---

## Bước 7 — Bảo mật firewall

```bash
ufw allow from <APP_SERVER_IP> to any port 4000
ufw allow 22
ufw enable
```

---

## Kiểm tra

Từ app server:

```bash
curl -H "x-worker-token: <token>" http://<WORKER_IP>:4000/status
```

Kết quả `{"busy":false,...}` → Worker hoạt động ✅

---

## Cập nhật code worker sau này

```bash
# Upload lại từ máy local
scp -r d:/nodejs/worker root@<WORKER_IP>:/opt/hls-worker

# Trên server worker
cd /opt/hls-worker && npm install && pm2 restart hls-worker
```
