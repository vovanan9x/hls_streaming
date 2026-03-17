---
description: Push code lên Git và deploy lên server production
---

// turbo-all

## Mỗi khi có thay đổi code (trên máy local Windows)

1. Mở terminal tại `d:\nodejs`, kiểm tra những file đã thay đổi:
```powershell
git status
```

2. Stage toàn bộ thay đổi:
```powershell
git add .
```

3. Commit với mô tả rõ ràng:
```powershell
git commit -m "fix: mô tả thay đổi"
```

4. Push lên GitHub:
```powershell
git push origin main
```

## Sau khi push xong — cập nhật lên server production

5. SSH vào VPS app server:
```bash
ssh root@<APP_SERVER_IP>
```

6. Pull code mới + restart app:
```bash
cd /opt/app && git pull && pm2 restart hls-app
```

7. Kiểm tra app chạy bình thường:
```bash
pm2 logs hls-app --lines 30
```

---

> Nếu có thay đổi `package.json` (thêm/xoá dependency), thêm `npm install` trước `pm2 restart`:
> ```bash
> cd /opt/app && git pull && npm install && pm2 restart hls-app
> ```