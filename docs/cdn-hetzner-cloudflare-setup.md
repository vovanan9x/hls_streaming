# Kiến trúc CDN 2 lớp + 3 Hetzner Dedicated Servers

## Tổng quan kiến trúc

```
Player/Browser
      │
      ▼
┌─────────────────┐
│  Cloudflare CDN │  ← CDN Lớp 1 (Anycast, DDoS protection)
│  (L1 Cache)     │
└────────┬────────┘
         │ Cache MISS
         ▼
┌─────────────────┐
│  BunnyCDN       │  ← CDN Lớp 2 (Pull Zone, origin shield)
│  (L2 Cache)     │
└────────┬────────┘
         │ Cache MISS
         ▼
┌──────────────────────────────────────┐
│  3x Hetzner Dedicated (Nginx + HLS) │  ← Origin
│  Server A (4TB×2) / B / C           │
└──────────────────────────────────────┘
         ▲
         │ SFTP upload
┌────────┴────────┐
│  Encode Worker  │  + App Server (VPS)
└─────────────────┘
```

---

## Phần 1: Setup 3 Hetzner Dedicated Servers

### 1.1 Cấu hình RAID (trên mỗi server)

```bash
# Kiểm tra ổ đĩa
lsblk

# Tạo RAID 1 (mirror) cho 2x4TB
apt install -y mdadm
mdadm --create /dev/md0 --level=1 --raid-devices=2 /dev/sda /dev/sdb

# Format và mount
mkfs.ext4 /dev/md0
mkdir -p /var/hls-storage
mount /dev/md0 /var/hls-storage

# Auto-mount khi boot
echo '/dev/md0 /var/hls-storage ext4 defaults 0 0' >> /etc/fstab

# Lưu config RAID
mdadm --detail --scan >> /etc/mdadm/mdadm.conf
update-initramfs -u
```

> **Kết quả:** Mỗi server có ~4TB usable (RAID 1), tổng 3 server = ~12TB an toàn.

### 1.2 Cấu trúc thư mục

```bash
mkdir -p /var/hls-storage/hls   # Lưu HLS segments (.ts + .m3u8)
mkdir -p /var/hls-storage/thumb # Thumbnails
chown -R www-data:www-data /var/hls-storage
```

### 1.3 Cài Nginx

```bash
apt update && apt install -y nginx

cat > /etc/nginx/sites-available/hls << 'EOF'
server {
    listen 80;
    server_name _;

    root /var/hls-storage;

    # HLS segments - cache cực lâu (immutable)
    location ~* \.(ts|key)$ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header Access-Control-Allow-Origin "*";
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS";
        expires 365d;
    }

    # Playlist - cache ngắn (thay đổi khi có update)
    location ~* \.m3u8$ {
        add_header Cache-Control "public, max-age=3600";
        add_header Access-Control-Allow-Origin "*";
        add_header Vary "Accept-Encoding";
        expires 1h;
    }

    # Thumbnail
    location ~* \.(jpg|jpeg|png|webp)$ {
        add_header Cache-Control "public, max-age=86400";
        add_header Access-Control-Allow-Origin "*";
        expires 1d;
    }

    # Tắt access log cho segments (I/O intensive)
    location ~* \.ts$ {
        access_log off;
    }

    # Security
    location ~ /\. { deny all; }
    location = /favicon.ico { access_log off; log_not_found off; }
}
EOF

ln -s /etc/nginx/sites-available/hls /etc/nginx/sites-enabled/hls
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

### 1.4 Cấu hình SFTP cho App upload

```bash
# Tạo user riêng cho SFTP upload (không dùng root)
useradd -m -s /bin/bash hlsupload
mkdir -p /home/hlsupload/.ssh
# Paste SSH public key của app server vào đây:
echo "ssh-rsa AAAA..." > /home/hlsupload/.ssh/authorized_keys
chmod 600 /home/hlsupload/.ssh/authorized_keys
chown -R hlsupload:hlsupload /home/hlsupload/.ssh

# Cấp quyền ghi vào storage
chown hlsupload:hlsupload /var/hls-storage/hls
chmod 755 /var/hls-storage/hls
```

---

## Phần 2: Setup BunnyCDN (CDN Lớp 2)

### 2.1 Tạo Pull Zone

1. Đăng ký tại [bunny.net](https://bunny.net)
2. **CDN → Add Pull Zone**
   - **Name:** `hls-origin`
   - **Origin URL:** `http://<IP-SERVER-A>` (server Hetzner chính)
   - **Pricing Zone:** Standard (hoặc High Volume)
3. Lưu **Pull Zone Hostname**: `hls-origin.b-cdn.net`

### 2.2 Cấu hình Cache Rules trong BunnyCDN

| Rule | Pattern | TTL |
|------|---------|-----|
| HLS Segments | `*.ts` | 1 năm |
| HLS Key | `*.key` | 1 năm |
| Playlists | `*.m3u8` | 1 giờ |
| Thumbnails | `*.jpg, *.png` | 7 ngày |

**Settings cần bật:**
- ✅ **Perma-Cache** (lưu segment vĩnh viễn, không expire)
- ✅ **Smart Edge Routing**
- ✅ **Geo Replication** nếu user rải rộng toàn cầu

### 2.3 Load Balancing 3 servers với BunnyCDN

BunnyCDN hỗ trợ **Multi-Origin / Load Balancing** (tính năng Pro):

```
Origin Group "hls-cluster":
  - http://<SERVER-A-IP>  weight: 1
  - http://<SERVER-B-IP>  weight: 1
  - http://<SERVER-C-IP>  weight: 1
  Mode: Round-Robin hoặc Least-Connections
```

> Nếu không dùng Pro, dùng DNS round-robin hoặc chỉ cần 1 origin chính.

---

## Phần 3: Setup Cloudflare (CDN Lớp 1)

### 3.1 DNS Configuration

Trong Cloudflare DNS, **KHÔNG trỏ thẳng vào Hetzner** mà trỏ vào BunnyCDN:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| CNAME | `cdn` | `hls-origin.b-cdn.net` | ✅ Proxied (orange cloud) |
| A | `storage-a` | `<IP-SERVER-A>` | ❌ DNS only (grey cloud) |
| A | `storage-b` | `<IP-SERVER-B>` | ❌ DNS only |
| A | `storage-c` | `<IP-SERVER-C>` | ❌ DNS only |

> `cdn.yourdomain.com` → Cloudflare caches → BunnyCDN caches → Hetzner origin

### 3.2 Cloudflare Cache Rules

Vào **Rules → Cache Rules:**

**Rule 1 — Cache HLS Segments:**
```
Field: URI Path
Operator: matches regex
Value: .*\.(ts|key|m3u8|jpg|png)$

Cache Settings:
  Cache Status: Eligible for cache
  Edge TTL: 1 year (ts, key) / 1 hour (m3u8)
  Browser TTL: Respect origin headers
```

**Rule 2 — Bypass Cache cho Admin:**
```
Field: URI Path
Operator: starts with
Value: /admin

Cache Settings: Bypass cache
```

### 3.3 Cloudflare Settings Khuyến nghị

| Setting | Value |
|---------|-------|
| SSL/TLS | Full (Strict) |
| HTTP/2 | ✅ On |
| HTTP/3 (QUIC) | ✅ On |
| Brotli | ✅ On |
| Rocket Loader | ❌ Off (gây lỗi player) |
| Polish (Image Optimization) | ✅ On (thumbnails) |
| Minify | JS/CSS ✅, HTML tùy chọn |

---

## Phần 4: URL Format và App Config

### 4.1 URL Schema

```
# Qua CDN 2 lớp (production)
https://cdn.yourdomain.com/hls/<videoId>/index.m3u8

# Trực tiếp từ origin (debug/internal)
http://<SERVER-A-IP>/hls/<videoId>/index.m3u8
```

### 4.2 Cấu hình App Server

Trong DB (bảng `servers`), điền:

| Field | Value |
|-------|-------|
| `ip` | IP server Hetzner (dùng cho SFTP upload) |
| `port` | 22 (SFTP) |
| `username` | `hlsupload` |
| `cdn_url` | `https://cdn.yourdomain.com` |
| `storage_path` | `/var/hls-storage/hls` |

App sẽ tự build URL: `https://cdn.yourdomain.com/hls/<videoId>/index.m3u8`

---

## Phần 5: Phân chia video giữa 3 servers

Nếu muốn phân tán tải, mỗi video assign về 1 server cụ thể. App đã có logic **"chọn server ít video nhất"** (least-loaded). Khi upload:

1. App chọn server ít video nhất (Server A, B, hoặc C)
2. Encode Worker SFTP lên server đó
3. Video URL dùng `cdn.yourdomain.com` (BunnyCDN tự pull đúng origin)

> Với BunnyCDN Multi-Origin, tất cả 3 server đều là origin — BunnyCDN tự route.

---

## Phần 6: Monitoring và Maintenance

### Cache hit rate

BunnyCDN cung cấp dashboard real-time. Mục tiêu:
- `.ts` segments → > 95% cache hit
- `.m3u8` playlists → > 80% cache hit

### Purge cache khi xóa video

```bash
# Purge BunnyCDN
curl -X DELETE "https://api.bunny.net/pullzone/<ZONE_ID>/purgeCache" \
  -H "AccessKey: <BUNNY_API_KEY>" \
  -d '{"Url": "https://cdn.yourdomain.com/hls/<videoId>/*"}'

# Cloudflare tự động hết cache khi BunnyCDN miss
# Hoặc purge thủ công qua Cloudflare API
```

App đã có tích hợp purge Cloudflare khi xóa video — cần thêm BunnyCDN purge tương tự.

---

## Chi phí ước tính (20TB traffic/tháng)

| Dịch vụ | Chi phí |
|---------|---------|
| 3× Hetzner Dedicated (AX41) | ~$120/tháng |
| BunnyCDN (20TB × $0.005/GB) | ~$100/tháng |
| Cloudflare (Free/Pro) | $0–$20/tháng |
| **Tổng** | **~$220–240/tháng** |

> So sánh: Cloudflare R2 + Workers sẽ đắt hơn ở quy mô 20TB+.
