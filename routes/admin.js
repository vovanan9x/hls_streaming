const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb, getSetting, setSetting, addErrorLog } = require('../database');
const { convertToHLS, generateThumbnail } = require('../services/ffmpeg');
const { downloadRemoteFile, UPLOAD_DIR, THUMB_DIR } = require('../services/upload');
const { requireAuth, requireAdmin, requireUploader } = require('../middleware/auth');
const { uploadHlsToServer } = require('../services/sftp');
const { getAllViewerCounts } = require('../services/viewers');
const { encodeQueue } = require('../services/queue');
const workerPool = require('../services/workerPool');


// Apply requireAuth to ALL admin routes
router.use(requireAuth);

// =============================
// HOME / DASHBOARD
// =============================

router.get(['/', '/home'], (req, res) => {
    const db = getDb();
    const userId = req.session.user.id;

    // Tổng video của toàn hệ thống
    const totalVideos = db.prepare(`SELECT COUNT(*) as cnt FROM videos`).get().cnt;
    const totalReady = db.prepare(`SELECT COUNT(*) as cnt FROM videos WHERE status='ready'`).get().cnt;
    const totalProcessing = db.prepare(`SELECT COUNT(*) as cnt FROM videos WHERE status='processing'`).get().cnt;
    const totalError = db.prepare(`SELECT COUNT(*) as cnt FROM videos WHERE status='error'`).get().cnt;

    // Video của user đang đăng nhập
    const myTotal = db.prepare(`SELECT COUNT(*) as cnt FROM videos WHERE uploaded_by=?`).get(userId).cnt;
    const myReady = db.prepare(`SELECT COUNT(*) as cnt FROM videos WHERE uploaded_by=? AND status='ready'`).get(userId).cnt;
    const myProcessing = db.prepare(`SELECT COUNT(*) as cnt FROM videos WHERE uploaded_by=? AND status='processing'`).get(userId).cnt;

    // Thêm thống kê cho admin
    const totalUsers = req.session.user.role === 'administrator'
        ? db.prepare(`SELECT COUNT(*) as cnt FROM users`).get().cnt : null;
    const totalServers = req.session.user.role === 'administrator'
        ? db.prepare(`SELECT COUNT(*) as cnt FROM servers`).get().cnt : null;
    const liveServers = req.session.user.role === 'administrator'
        ? db.prepare(`SELECT COUNT(*) as cnt FROM servers WHERE status='live'`).get().cnt : null;

    // 5 video mới nhất của user
    const recentVideos = db.prepare(`
        SELECT v.id, v.title, v.status, v.progress, v.created_at, s.label as server_label
        FROM videos v LEFT JOIN servers s ON v.server_id = s.id
        WHERE v.uploaded_by = ?
        ORDER BY v.created_at DESC LIMIT 5
    `).all(userId);

    res.render('admin/home', {
        title: 'Tổng quan',
        stats: { totalVideos, totalReady, totalProcessing, totalError, myTotal, myReady, myProcessing, totalUsers, totalServers, liveServers },
        recentVideos
    });
});

// =============================
// VIDEO ROUTES
// =============================

// Multer config for video files
const videoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${crypto.randomUUID()}${ext}`);
    }
});

const thumbStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.mkdirSync(THUMB_DIR, { recursive: true });
        cb(null, THUMB_DIR);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${crypto.randomUUID()}${ext}`);
    }
});

const upload = multer({
    storage: videoStorage,
    fileFilter: (req, file, cb) => {
        const allowed = ['.mp4', '.mkv', '.avi', '.mov', '.webm'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Chỉ chấp nhận file video: mp4, mkv, avi, mov, webm'));
        }
    }
});

const thumbUpload = multer({
    storage: thumbStorage,
    fileFilter: (req, file, cb) => {
        const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Chỉ chấp nhận file ảnh: png, jpg, jpeg, webp'));
        }
    }
});

// GET /admin/upload - Upload video page (uploader + admin)
router.get('/upload', requireUploader, (req, res) => {
    const db = getDb();
    const servers = db.prepare('SELECT * FROM servers WHERE is_active = 1 ORDER BY label').all();
    const noServers = servers.length === 0;
    res.render('admin/upload', { title: 'Upload Video', servers, noServers, error: null, success: null });
});

// POST /admin/upload - Handle video upload (uploader + admin)
router.post('/upload', requireUploader, (req, res) => {
    const uploadFields = upload.fields([{ name: 'video', maxCount: 1 }]);
    uploadFields(req, res, async (err) => {
        const db = getDb();
        const servers = db.prepare('SELECT * FROM servers WHERE is_active = 1 ORDER BY label').all();
        const noServers = servers.length === 0;

        if (err) {
            return res.render('admin/upload', { title: 'Upload Video', servers, noServers, error: err.message, success: null });
        }

        try {
            const { title, description, upload_type, remote_url, server_id, thumb_mode } = req.body;

            if (!title || !title.trim()) {
                return res.render('admin/upload', { title: 'Upload Video', servers, noServers, error: 'Vui lòng nhập tiêu đề video', success: null });
            }
            if (!server_id) {
                return res.render('admin/upload', { title: 'Upload Video', servers, noServers, error: 'Vui lòng chọn server lưu trữ. Nếu chưa có server, hãy thêm server trước.', success: null });
            }

            const selectedServer = db.prepare('SELECT * FROM servers WHERE id = ? AND is_active = 1').get(server_id);
            if (!selectedServer) {
                return res.render('admin/upload', { title: 'Upload Video', servers, noServers, error: 'Server không hợp lệ hoặc đã bị vô hiệu hoá.', success: null });
            }

            let videoFilePath, videoFileName;

            if (upload_type === 'remote' && remote_url) {
                try {
                    const result = await downloadRemoteFile(remote_url, 'video.mp4');
                    videoFilePath = result.filePath;
                    videoFileName = result.fileName;
                } catch (dlErr) {
                    return res.render('admin/upload', { title: 'Upload Video', servers, noServers, error: `Lỗi tải file remote: ${dlErr.message}`, success: null });
                }
            } else if (req.files && req.files.video && req.files.video[0]) {
                videoFilePath = req.files.video[0].path;
                videoFileName = req.files.video[0].filename;
            } else {
                return res.render('admin/upload', { title: 'Upload Video', servers, noServers, error: 'Vui lòng chọn file video hoặc nhập URL', success: null });
            }

            const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM videos').get();

            let qualities = req.body.qualities;
            if (!qualities) qualities = ['sd'];
            if (!Array.isArray(qualities)) qualities = [qualities];
            const validQualities = ['sd', 'hd'];
            qualities = qualities.filter(q => validQualities.includes(q));
            if (qualities.length === 0) qualities = ['sd'];
            const qualitiesJson = JSON.stringify(qualities);

            const result = db.prepare(`
        INSERT INTO videos (title, description, video_file, server_id, uploaded_by, status, qualities, visibility, sort_order)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(title.trim(), description || '', videoFileName, server_id, req.session.user.id, qualitiesJson, req.body.visibility || 'public', maxOrder.max_order + 1);

            const videoId = result.lastInsertRowid;
            const queuePos = encodeQueue.push({ videoId, videoFilePath, videoFileName, autoThumb: thumb_mode !== 'upload', qualities });

            const queueMsg = queuePos === 0 && !encodeQueue.running
                ? 'Đang xử lý ngay...'
                : `Trong hàng đợi (vị trí ${encodeQueue.size})...`;
            return res.render('admin/upload', {
                title: 'Upload Video',
                servers,
                noServers,
                error: null,
                success: `Video "${title}" đã được upload lên [${selectedServer.label}]! ${queueMsg}`
            });

        } catch (e) {
            console.error('[Upload Error]', e);
            const servers2 = db.prepare('SELECT * FROM servers WHERE is_active = 1 ORDER BY label').all();
            return res.render('admin/upload', { title: 'Upload Video', servers: servers2, noServers: servers2.length === 0, error: `Lỗi server: ${e.message}`, success: null });
        }
    });
});

// POST /admin/upload-thumbnail (uploader + admin)
router.post('/upload-thumbnail', requireUploader, thumbUpload.single('thumbnail'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    res.json({ filename: req.file.filename, path: `/uploads/thumbnails/${req.file.filename}` });
});

/**
 * Process video: multi-quality HLS encode → upload lên server được chọn (R2 hoặc SFTP)
 */
async function processVideo(videoId, videoFilePath, videoFileName, autoThumb = true, qualities = ['sd']) {
    const db = getDb();
    const STORAGE_DIR = path.join(__dirname, '..', 'storage');

    try {
        // Mark as processing
        db.prepare("UPDATE videos SET status = 'processing', progress = 0 WHERE id = ?").run(videoId);

        const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
        if (!video || !video.server_id) {
            throw new Error(`Video ${videoId} không có server_id — không thể upload.`);
        }
        const serverInfo = db.prepare('SELECT * FROM servers WHERE id = ?').get(video.server_id);
        if (!serverInfo) {
            throw new Error(`Server ${video.server_id} không tồn tại.`);
        }

        if (!qualities || qualities.length === 0) {
            try { qualities = JSON.parse(video.qualities || '["sd"]'); } catch (e) { qualities = ['sd']; }
        }

        // Step 1: Encode HLS locally
        const localHlsBase = path.join(STORAGE_DIR, 'hls');
        fs.mkdirSync(localHlsBase, { recursive: true });
        let lastPercent = -1;
        try {
            await convertToHLS(videoFilePath, localHlsBase, videoId.toString(), qualities, (pct) => {
                if (pct > lastPercent) { lastPercent = pct; db.prepare('UPDATE videos SET progress = ? WHERE id = ?').run(pct, videoId); }
            });
        } catch (encodeErr) {
            addErrorLog('encode', {
                videoId, videoTitle: video.title,
                serverId: video.server_id, serverLabel: serverInfo ? serverInfo.label : '',
                message: encodeErr.message, stack: encodeErr.stack
            });
            throw encodeErr;
        }

        const localHlsDir = path.join(localHlsBase, videoId.toString());
        let m3u8Url;
        const iframeUrl = `/embed/${videoId}`;

        // Step 2: Upload lên server được chọn
        db.prepare("UPDATE videos SET status = 'uploading', progress = 99 WHERE id = ?").run(videoId);

        // Upload qua SFTP (Hetzner, VPS...)
        try {
            await uploadHlsToServer(serverInfo, localHlsDir, videoId.toString());
            // Dùng CDN Pool (nhiều CF accounts) nếu có, fallback về cdn_url hoặc IP
            const { buildM3u8Url } = require('../services/cdnPool');
            m3u8Url = buildM3u8Url(serverInfo.id, videoId, serverInfo);
            console.log(`[SFTP] Upload complete: ${m3u8Url}`);
        } catch (sftpErr) {
            addErrorLog('sftp', {
                videoId, videoTitle: video.title,
                serverId: serverInfo.id, serverLabel: serverInfo.label,
                message: sftpErr.message, stack: sftpErr.stack
            });
            throw sftpErr;
        }

        // Step 3: Thumbnail
        let thumbnailName = '';
        if (autoThumb) {
            try { thumbnailName = `thumb_${videoId}.jpg`; await generateThumbnail(videoFilePath, THUMB_DIR, thumbnailName); }
            catch (e) { console.error('[Thumb] failed:', e.message); thumbnailName = ''; }
        }

        // Step 4: Mark ready
        db.prepare(`UPDATE videos SET m3u8_url=?, iframe_url=?, thumbnail=?, status='ready', progress=100,
            updated_at=datetime('now','localtime') WHERE id=?`)
            .run(m3u8Url, iframeUrl, thumbnailName, videoId);

        console.log(`[Process] Video ${videoId} ready → ${m3u8Url} [${qualities.join(', ')}]`);
    } catch (err) {
        console.error(`[Process] Video ${videoId} failed:`, err.message);
        // Only log to error_logs if it wasn't already logged by a specific catch above
        if (!err._logged) {
            addErrorLog('unknown', {
                videoId, videoTitle: '',
                message: err.message, stack: err.stack
            });
        }
        db.prepare("UPDATE videos SET status='error', updated_at=datetime('now','localtime') WHERE id=?").run(videoId);
    }
}

// Wire the queue processor
encodeQueue.setProcessor(processVideo);



// GET /admin/videos - Video management list (all roles see all videos)
router.get('/videos', requireAuth, (req, res) => {
    const db = getDb();
    const user = req.session.user;

    // Tất cả roles đều thấy toàn bộ video
    const videos = db.prepare(`
      SELECT v.*, s.label as server_label, u.username as uploader_name
      FROM videos v 
      LEFT JOIN servers s ON v.server_id = s.id 
      LEFT JOIN users u ON v.uploaded_by = u.id
      ORDER BY v.sort_order DESC, v.created_at DESC
    `).all();

    // Lấy danh sách video_id đang có pending delete request (để disable nút)
    const pendingVideoIds = db.prepare(
        `SELECT video_id FROM delete_requests WHERE status='pending'`
    ).all().map(r => r.video_id);

    res.render('admin/videos', { title: 'Quản lí Video', videos, pendingVideoIds });
});

// GET /admin/videos/:id/edit - Video edit page (admin only)
router.get('/videos/:id/edit', requireAdmin, (req, res) => {
    const db = getDb();
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) return res.redirect('/admin/videos');
    const servers = db.prepare('SELECT * FROM servers WHERE is_active = 1 ORDER BY label').all();
    res.render('admin/video-edit', { title: 'Sửa Video', video, servers, error: null, success: null });
});

// POST /admin/videos/:id/edit - Update video (admin only)
router.post('/videos/:id/edit', requireAdmin, (req, res) => {
    const db = getDb();
    const { title, description, m3u8_url, iframe_url } = req.body;
    db.prepare(`
    UPDATE videos 
    SET title = ?, description = ?, m3u8_url = ?, iframe_url = ?, updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(title, description || '', m3u8_url || '', iframe_url || '', req.params.id);

    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    const servers = db.prepare('SELECT * FROM servers WHERE is_active = 1 ORDER BY label').all();
    res.render('admin/video-edit', { title: 'Sửa Video', video, servers, error: null, success: 'Cập nhật thành công!' });
});

// POST /admin/videos/:id/delete - Delete video (admin only)
router.post('/videos/:id/delete', requireAdmin, (req, res) => {
    const db = getDb();
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);

    if (video) {
        const hlsDir = path.join(__dirname, '..', 'storage', 'hls', video.id.toString());
        if (fs.existsSync(hlsDir)) {
            fs.rmSync(hlsDir, { recursive: true, force: true });
        }

        if (video.video_file) {
            const videoPath = path.join(UPLOAD_DIR, video.video_file);
            if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        }

        if (video.thumbnail) {
            const thumbPath = path.join(THUMB_DIR, video.thumbnail);
            if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
        }

        db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
    }

    res.redirect('/admin/videos');
});

// POST /admin/videos/:id/cancel - Hủy upload/sử lý và xóa rác
router.post('/videos/:id/cancel', requireAuth, (req, res) => {
    const db = getDb();
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);

    if (video) {
        // Must be admin or the user who uploaded the video (use == for type coercion int vs string)
        // eslint-disable-next-line eqeqeq
        if (req.session.user.role !== 'administrator' && video.uploaded_by != req.session.user.id) {
            console.log(`[Cancel] Forbidden: user ${req.session.user.id} tried to cancel video ${video.id} owned by ${video.uploaded_by}`);
            return res.status(403).redirect('/admin/videos');
        }

        const hlsDir = path.join(__dirname, '..', 'storage', 'hls', video.id.toString());

        // 1. Huỷ tiến trình encode thông qua queue (sẽ tự chặn nếu đang xếp hàng / đánh dấu cờ cancel)
        const { encodeQueue } = require('../services/queue');
        encodeQueue.cancel(video.id);

        // 2. Kill ffmpeg (sẽ ném error để promise catch lại và thoát an toàn)
        const { killFFmpeg } = require('../services/ffmpeg');
        killFFmpeg(video.id.toString());
        killFFmpeg(video.id);

        // 3. Xóa database LUÔN để giao diện phản hồi nhanh
        db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);

        // 4. Xóa file rác (Dùng setTimeout trên Windows để FFmpeg nhả lock file)
        setTimeout(() => {
            try {
                if (fs.existsSync(hlsDir)) {
                    fs.rmSync(hlsDir, { recursive: true, force: true });
                }

                const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'videos');
                const THUMB_DIR = path.join(__dirname, '..', 'uploads', 'thumbnails');

                if (video.video_file) {
                    const videoPath = path.join(UPLOAD_DIR, video.video_file);
                    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
                }
                if (video.thumbnail) {
                    const thumbPath = path.join(THUMB_DIR, video.thumbnail);
                    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
                }
                console.log(`[Cancel] Cleanup success for video ${video.id}`);
            } catch (err) {
                console.error(`[Cancel] Cleanup non-fatal err for video ${video.id}:`, err.message);
            }
        }, 1500);
    }

    res.redirect('/admin/videos');
});

// POST /admin/videos/:id/push-top - Push video to top (admin only)
router.post('/videos/:id/push-top', requireAdmin, (req, res) => {
    const db = getDb();
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM videos').get();
    db.prepare(`
    UPDATE videos SET sort_order = ?, updated_at = datetime('now','localtime') WHERE id = ?
  `).run(maxOrder.max_order + 1, req.params.id);
    res.redirect('/admin/videos');
});

// POST /admin/videos/:id/delete-request — Uploader gửi yêu cầu xoá
router.post('/videos/:id/delete-request', requireUploader, (req, res) => {
    const db = getDb();
    const videoId = req.params.id;
    const userId = req.session.user.id;

    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    if (!video) {
        return res.redirect('/admin/videos?msg=notfound');
    }

    // Kiểm tra đã có pending request chưa
    const existing = db.prepare(
        `SELECT id FROM delete_requests WHERE video_id = ? AND status = 'pending'`
    ).get(videoId);

    if (existing) {
        return res.redirect('/admin/videos?msg=already_pending');
    }

    const reason = (req.body.reason || '').trim().substring(0, 500);
    db.prepare(`
        INSERT INTO delete_requests (video_id, video_title, requested_by, reason)
        VALUES (?, ?, ?, ?)
    `).run(videoId, video.title, userId, reason);

    res.redirect('/admin/videos?msg=requested');
});

// =============================
// DELETE REQUESTS (admin only)
// =============================

// GET /admin/delete-requests — Admin xem danh sách yêu cầu xoá
router.get('/delete-requests', requireAdmin, (req, res) => {
    const db = getDb();
    const requests = db.prepare(`
        SELECT dr.*, v.title as video_title_live, v.thumbnail as video_thumb,
               u.username as requester_name,
               rv.username as reviewer_name
        FROM delete_requests dr
        LEFT JOIN videos v ON dr.video_id = v.id
        LEFT JOIN users u ON dr.requested_by = u.id
        LEFT JOIN users rv ON dr.reviewed_by = rv.id
        ORDER BY CASE dr.status WHEN 'pending' THEN 0 ELSE 1 END, dr.created_at DESC
    `).all();

    const pendingCount = requests.filter(r => r.status === 'pending').length;

    res.render('admin/delete-requests', {
        title: 'Yêu cầu Xoá Video',
        requests,
        pendingCount,
        msg: req.query.msg || null
    });
});

// POST /admin/delete-requests/:id/approve — Admin duyệt, xoá video thật
router.post('/delete-requests/:id/approve', requireAdmin, (req, res) => {
    const db = getDb();
    const reqRow = db.prepare('SELECT * FROM delete_requests WHERE id = ?').get(req.params.id);
    if (!reqRow || reqRow.status !== 'pending') {
        return res.redirect('/admin/delete-requests?msg=invalid');
    }

    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(reqRow.video_id);
    if (video) {
        // Xoá file HLS
        const hlsDir = path.join(__dirname, '..', 'storage', 'hls', video.id.toString());
        if (fs.existsSync(hlsDir)) {
            fs.rmSync(hlsDir, { recursive: true, force: true });
        }
        // Xoá video file gốc
        if (video.video_file) {
            const videoPath = path.join(UPLOAD_DIR, video.video_file);
            if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        }
        // Xoá thumbnail
        if (video.thumbnail) {
            const thumbPath = path.join(THUMB_DIR, video.thumbnail);
            if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
        }
        // Xoá DB video (delete_requests sẽ cascade → video_id = NULL vì ON DELETE CASCADE)
        db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
    }

    // Cập nhật trạng thái yêu cầu
    db.prepare(`
        UPDATE delete_requests
        SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now','localtime')
        WHERE id = ?
    `).run(req.session.user.id, reqRow.id);

    res.redirect('/admin/delete-requests?msg=approved');
});

// POST /admin/delete-requests/:id/reject — Admin từ chối
router.post('/delete-requests/:id/reject', requireAdmin, (req, res) => {
    const db = getDb();
    const reqRow = db.prepare('SELECT id, status FROM delete_requests WHERE id = ?').get(req.params.id);
    if (!reqRow || reqRow.status !== 'pending') {
        return res.redirect('/admin/delete-requests?msg=invalid');
    }

    db.prepare(`
        UPDATE delete_requests
        SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now','localtime')
        WHERE id = ?
    `).run(req.session.user.id, reqRow.id);

    res.redirect('/admin/delete-requests?msg=rejected');
});



router.get('/servers', requireAdmin, (req, res) => {
    const db = getDb();
    const servers = db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all();
    res.render('admin/servers', { title: 'Quản lí Server', servers });
});

router.get('/servers/add', requireAdmin, (req, res) => {
    res.render('admin/server-form', { title: 'Thêm Server', server: null, error: null, success: null });
});

router.post('/servers/add', requireAdmin, async (req, res) => {
    const db = getDb();
    const { label, ip, port, username, password, storage_path, cdn_url } = req.body;

    if (!label) {
        return res.render('admin/server-form', {
            title: 'Thêm Server', server: req.body,
            error: 'Vui lòng nhập Label cho server.', success: null
        });
    }
    if (!ip || !username) {
        return res.render('admin/server-form', {
            title: 'Thêm Server', server: req.body,
            error: 'Vui lòng điền IP Address và Username.', success: null
        });
    }

    db.prepare(`
        INSERT INTO servers (label, server_type, ip, port, username, password, storage_path, cdn_url)
        VALUES (?, 'sftp', ?, ?, ?, ?, ?, ?)
    `).run(label, ip || '', parseInt(port) || 22, username || '', password || '',
        storage_path || '/var/hls-storage', cdn_url || '');

    res.redirect('/admin/servers');
});

router.get('/servers/:id/edit', requireAdmin, (req, res) => {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.redirect('/admin/servers');
    res.render('admin/server-form', { title: 'Sửa Server', server, error: null, success: null });
});

router.post('/servers/:id/edit', requireAdmin, async (req, res) => {
    const db = getDb();
    const { label, ip, port, username, password, storage_path, cdn_url } = req.body;

    if (!label) {
        const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
        return res.render('admin/server-form', { title: 'Sửa Server', server: { ...server, ...req.body }, error: 'Vui lòng nhập Label.', success: null });
    }

    // Giữ nguyên password nếu để trống
    let finalPassword = password;
    if (!finalPassword || !finalPassword.trim()) {
        const existing = db.prepare('SELECT password FROM servers WHERE id = ?').get(req.params.id);
        finalPassword = existing ? existing.password : '';
    }

    db.prepare(`
        UPDATE servers
        SET label=?, server_type='sftp', ip=?, port=?, username=?, password=?, storage_path=?,
            cdn_url=?, updated_at=datetime('now','localtime')
        WHERE id=?
    `).run(label, ip || '', parseInt(port) || 22, username || '', finalPassword || '',
        storage_path || '/var/hls-storage', cdn_url || '', req.params.id);

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    res.render('admin/server-form', { title: 'Sửa Server', server, error: null, success: 'Cập nhật thành công!' });
});

router.post('/servers/:id/delete', requireAdmin, (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM servers WHERE id = ?').run(req.params.id);
    res.redirect('/admin/servers');
});

router.get('/api/servers/status', requireAuth, (req, res) => {
    const db = getDb();
    const servers = db.prepare('SELECT id, status, last_checked FROM servers').all();
    res.json(servers);
});

// POST /admin/api/servers/:id/ping — test kết nối thực tế (SFTP hoặc R2), cập nhật DB
router.post('/api/servers/:id/ping', requireAdmin, async (req, res) => {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.json({ ok: false, message: 'Server không tồn tại.' });

    let ok = false;
    let message = '';
    const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    try {
        const { testConnection } = require('../services/sftp');
        ok = await testConnection(server);
        message = ok ? `SFTP kết nối ${server.ip}:${server.port} thành công!` : `SFTP kết nối thất bại — server không phản hồi.`;
    } catch (e) {
        ok = false;
        message = e.message;
    }

    const newStatus = ok ? 'live' : 'die';
    db.prepare(`UPDATE servers SET status=?, last_checked=? WHERE id=?`).run(newStatus, now, server.id);

    res.json({ ok, status: newStatus, message, last_checked: now });
});



// =============================
// USER MANAGEMENT (admin only)
// =============================

router.get('/users', requireAdmin, (req, res) => {
    const db = getDb();
    const users = db.prepare('SELECT id, username, display_name, role, is_active, created_at FROM users ORDER BY created_at DESC').all();
    res.render('admin/users', { title: 'Quản lí Tài khoản', users, error: null, success: null });
});

router.get('/users/add', requireAdmin, (req, res) => {
    res.render('admin/user-form', { title: 'Thêm Tài khoản', user: null, error: null, success: null });
});

router.post('/users/add', requireAdmin, (req, res) => {
    const db = getDb();
    const { username, password, display_name, role } = req.body;

    if (!username || !password) {
        return res.render('admin/user-form', {
            title: 'Thêm Tài khoản',
            user: req.body,
            error: 'Vui lòng nhập username và password',
            success: null
        });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
    if (existing) {
        return res.render('admin/user-form', {
            title: 'Thêm Tài khoản',
            user: req.body,
            error: 'Username đã tồn tại',
            success: null
        });
    }

    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`
    INSERT INTO users (username, password, display_name, role)
    VALUES (?, ?, ?, ?)
  `).run(username.trim(), hash, display_name || '', role || 'uploader');

    res.redirect('/admin/users');
});

router.get('/users/:id/edit', requireAdmin, (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT id, username, display_name, role, is_active FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.redirect('/admin/users');
    res.render('admin/user-form', { title: 'Sửa Tài khoản', user, error: null, success: null });
});

router.post('/users/:id/edit', requireAdmin, (req, res) => {
    const db = getDb();
    const { display_name, role, is_active, new_password } = req.body;

    if (new_password && new_password.trim()) {
        const hash = bcrypt.hashSync(new_password.trim(), 10);
        db.prepare(`
      UPDATE users SET display_name = ?, role = ?, is_active = ?, password = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(display_name || '', role || 'uploader', is_active ? 1 : 0, hash, req.params.id);
    } else {
        db.prepare(`
      UPDATE users SET display_name = ?, role = ?, is_active = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(display_name || '', role || 'uploader', is_active ? 1 : 0, req.params.id);
    }

    const user = db.prepare('SELECT id, username, display_name, role, is_active FROM users WHERE id = ?').get(req.params.id);
    res.render('admin/user-form', { title: 'Sửa Tài khoản', user, error: null, success: 'Cập nhật thành công!' });
});

router.post('/users/:id/delete', requireAdmin, (req, res) => {
    const db = getDb();
    // Prevent deleting yourself
    if (parseInt(req.params.id) === req.session.user.id) {
        return res.redirect('/admin/users');
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.redirect('/admin/users');
});

// =============================
// PROGRESS API (for client polling)
// =============================

// POST /admin/api/videos/:id/cancel — JSON cancel endpoint (dùng bởi AJAX)
router.post('/api/videos/:id/cancel', requireAuth, (req, res) => {
    const db = getDb();
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);

    if (!video) return res.json({ ok: false, message: 'Video không tồn tại.' });

    // eslint-disable-next-line eqeqeq
    if (req.session.user.role !== 'administrator' && video.uploaded_by != req.session.user.id) {
        return res.status(403).json({ ok: false, message: 'Không có quyền.' });
    }

    const hlsDir = require('path').join(__dirname, '..', 'storage', 'hls', video.id.toString());

    // Kill queue + FFmpeg
    encodeQueue.cancel(video.id);
    const { killFFmpeg } = require('../services/ffmpeg');
    killFFmpeg(video.id.toString());
    killFFmpeg(video.id);

    // Xoá DB ngay để phản hồi nhanh
    db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);

    // Xoá file rác sau 1.5s (tránh Windows lock)
    setTimeout(() => {
        try {
            if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });
            if (video.video_file) {
                const vp = require('path').join(UPLOAD_DIR, video.video_file);
                if (fs.existsSync(vp)) fs.unlinkSync(vp);
            }
            if (video.thumbnail) {
                const tp = require('path').join(THUMB_DIR, video.thumbnail);
                if (fs.existsSync(tp)) fs.unlinkSync(tp);
            }
        } catch (e) { console.error('[Cancel API] cleanup:', e.message); }
    }, 1500);

    res.json({ ok: true, message: 'Đã hủy và xóa video.' });
});

// GET /admin/api/viewers — số người đang xem theo videoId
router.get('/api/viewers', requireAuth, (req, res) => {
    res.json(getAllViewerCounts());
});

// GET /admin/api/videos/progress — includes queued/processing/uploading
router.get('/api/videos/progress', requireAuth, (req, res) => {
    const db = getDb();
    const rows = db.prepare(
        `SELECT id, status, progress FROM videos WHERE status IN ('queued','processing','uploading')`
    ).all();
    res.json(rows);
});

// GET /admin/api/queue — queue snapshot for display
router.get('/api/queue', requireAuth, (req, res) => {
    res.json({ current: encodeQueue.currentId, queue: encodeQueue.snapshot(), size: encodeQueue.size });
});

// =============================
// SETTINGS (admin only)
// =============================
router.get('/settings', requireAdmin, (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT api_token FROM users WHERE id = ?').get(req.session.user.id);
    res.render('admin/settings', {
        title: 'Cài đặt Hệ thống',
        apiToken: user ? user.api_token : null,
        success: req.query.saved ? 'Đã lưu cài đặt!' : null,
        error: null,
    });
});

router.post('/settings/r2', requireAdmin, (req, res) => {
    const { r2_account_id, r2_access_key, r2_secret_key, r2_bucket, r2_public_url } = req.body;
    setSetting('r2_account_id', r2_account_id || '');
    setSetting('r2_access_key', r2_access_key || '');
    setSetting('r2_secret_key', r2_secret_key || '');
    setSetting('r2_bucket', r2_bucket || '');
    setSetting('r2_public_url', r2_public_url || '');
    if (r2_account_id && r2_access_key && r2_bucket) {
        r2.init({ accountId: r2_account_id, accessKeyId: r2_access_key, secretAccessKey: r2_secret_key, bucket: r2_bucket, publicUrl: r2_public_url });
    }
    res.redirect('/admin/settings?saved=1');
});

router.post('/settings/r2/test', requireAdmin, async (req, res) => {
    const ok = await r2.testConnection();
    res.json({ ok, message: ok ? 'Kết nối R2 thành công!' : 'Kết nối thất bại — kiểm tra lại thông tin.' });
});

router.post('/settings/token/generate', requireAdmin, (req, res) => {
    const db = getDb();
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE users SET api_token = ? WHERE id = ?').run(token, req.session.user.id);
    res.redirect('/admin/settings?saved=1');
});

router.post('/settings/token/revoke', requireAdmin, (req, res) => {
    const db = getDb();
    db.prepare('UPDATE users SET api_token = NULL WHERE id = ?').run(req.session.user.id);
    res.redirect('/admin/settings?saved=1');
});

// =============================
// API DOCS
// =============================
router.get('/api-docs', requireAdmin, (req, res) => {
    const db = getDb();
    const servers = db.prepare('SELECT id, label, server_type FROM servers WHERE is_active=1').all();
    const user = db.prepare('SELECT api_token FROM users WHERE id = ?').get(req.session.user.id);
    res.render('admin/api-docs', {
        title: 'API Documentation',
        servers,
        apiToken: user ? (user.api_token || '') : ''
    });
});

// =============================
// ANALYTICS
// =============================
router.get('/analytics', requireAuth, (req, res) => {
    const db = getDb();
    const user = req.session.user;
    const isAdmin = user.role === 'administrator';

    // Views per day (last 7 days)
    const dailyViews = db.prepare(`
        SELECT DATE(last_ping) as day, COUNT(DISTINCT session_key) as views
        FROM view_logs
        WHERE last_ping >= DATE('now', '-7 days')
        ${!isAdmin ? 'AND video_id IN (SELECT id FROM videos WHERE uploaded_by = ?)' : ''}
        GROUP BY day ORDER BY day ASC
    `).all(...(!isAdmin ? [user.id] : []));

    // Top 10 videos
    const topVideos = db.prepare(`
        SELECT v.id, v.title, COUNT(DISTINCT l.session_key) as total_views
        FROM videos v LEFT JOIN view_logs l ON l.video_id = v.id
        WHERE v.status = 'ready'
        ${!isAdmin ? 'AND v.uploaded_by = ?' : ''}
        GROUP BY v.id ORDER BY total_views DESC LIMIT 10
    `).all(...(!isAdmin ? [user.id] : []));

    // Total unique viewers
    const totalViews = db.prepare(`
        SELECT COUNT(DISTINCT session_key) as cnt FROM view_logs
        ${!isAdmin ? 'WHERE video_id IN (SELECT id FROM videos WHERE uploaded_by = ?)' : ''}
    `).get(...(!isAdmin ? [user.id] : []));

    res.render('admin/analytics', {
        title: 'Thống kê',
        dailyViews,
        topVideos,
        totalViews: totalViews.cnt,
    });
});

// =============================
// ENCODE WORKERS (admin)
// =============================

/** GET /admin/workers — danh sách workers */
router.get('/workers', requireAdmin, async (req, res) => {
    const workers = await workerPool.getAllWorkersStatus();
    res.render('admin/workers', { title: 'Encode Workers', workers, msg: req.query.msg || null });
});

/** POST /admin/workers/add — thêm worker */
router.post('/workers/add', requireAdmin, (req, res) => {
    const { label, url, token } = req.body;
    if (!label || !url || !token) return res.redirect('/admin/workers?msg=missing');
    const workers = workerPool.getWorkers();
    workers.push({ label: label.trim(), url: url.trim().replace(/\/$/, ''), token: token.trim() });
    workerPool.saveWorkers(workers);
    res.redirect('/admin/workers?msg=added');
});

/** POST /admin/workers/:idx/delete — xoá worker */
router.post('/workers/:idx/delete', requireAdmin, (req, res) => {
    const workers = workerPool.getWorkers();
    const idx = parseInt(req.params.idx);
    if (idx >= 0 && idx < workers.length) workers.splice(idx, 1);
    workerPool.saveWorkers(workers);
    res.redirect('/admin/workers?msg=deleted');
});

/** POST /admin/api/worker/progress — Worker báo progress về */
router.post('/api/worker/progress', (req, res) => {
    const token = req.headers['x-worker-token'];
    const workers = workerPool.getWorkers();
    const valid = workers.some(w => w.token === token);
    if (!valid) return res.status(401).json({ error: 'Unauthorized' });

    const { videoId, progress } = req.body;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

    const db = getDb();
    db.prepare(`UPDATE videos SET progress=?, status='processing', updated_at=datetime('now','localtime') WHERE id=?`)
        .run(Math.min(progress || 0, 99), videoId);
    res.json({ ok: true });
});

/** POST /admin/api/worker/done — Worker báo encode thành công */
router.post('/api/worker/done', (req, res) => {
    const token = req.headers['x-worker-token'];
    const workers = workerPool.getWorkers();
    const valid = workers.some(w => w.token === token);
    if (!valid) return res.status(401).json({ error: 'Unauthorized' });

    const { videoId, thumbnailName } = req.body;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

    const db = getDb();
    const video = db.prepare('SELECT * FROM videos WHERE id=?').get(videoId);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    // Build m3u8 URL từ server config (CDN URL hoặc IP)
    const serverInfo = db.prepare('SELECT * FROM servers WHERE id=?').get(video.server_id);
    let m3u8Url = '';
    if (serverInfo) {
        if (serverInfo.cdn_url && serverInfo.cdn_url.trim()) {
            m3u8Url = `${serverInfo.cdn_url.replace(/\/$/, '')}/hls/${videoId}/master.m3u8`;
        } else {
            const base = (serverInfo.storage_path || '/var/hls-storage').replace(/\/$/, '');
            m3u8Url = `http://${serverInfo.ip}:80${base}/${videoId}/master.m3u8`;
        }
    }

    const iframeUrl = m3u8Url ? `/watch/${videoId}` : '';
    db.prepare(`UPDATE videos SET m3u8_url=?, iframe_url=?, thumbnail=?, status='ready', progress=100,
        updated_at=datetime('now','localtime') WHERE id=?`)
        .run(m3u8Url, iframeUrl, thumbnailName || video.thumbnail || '', videoId);

    const { encodeQueue } = require('../services/queue');
    encodeQueue.markRemoteDone(videoId);

    console.log(`[Worker Callback] Video ${videoId} DONE → ${m3u8Url}`);
    res.json({ ok: true });
});

/** POST /admin/api/worker/error — Worker báo lỗi */
router.post('/api/worker/error', (req, res) => {
    const token = req.headers['x-worker-token'];
    const workers = workerPool.getWorkers();
    const valid = workers.some(w => w.token === token);
    if (!valid) return res.status(401).json({ error: 'Unauthorized' });

    const { videoId, error } = req.body;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

    const db = getDb();
    const video = db.prepare('SELECT title FROM videos WHERE id=?').get(videoId);
    db.prepare(`UPDATE videos SET status='error', updated_at=datetime('now','localtime') WHERE id=?`).run(videoId);
    addErrorLog('encoding', {
        videoId, videoTitle: video ? video.title : '',
        message: error || 'Unknown worker error',
    });

    const { encodeQueue } = require('../services/queue');
    encodeQueue.markRemoteDone(videoId);

    console.error(`[Worker Callback] Video ${videoId} ERROR:`, error);
    res.json({ ok: true });
});

module.exports = router;


// Appended below: error log routes
router.get('/errors', requireAdmin, (req, res) => {
    const db = getDb();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;
    const type = req.query.type || '';

    const where = type ? `WHERE type = '${type.replace(/'/g, '')}'` : '';
    const logs = db.prepare(`SELECT * FROM error_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM error_logs ${where}`).get().cnt;

    res.render('admin/errors', {
        title: 'Nhật ký Lỗi',
        logs,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        filterType: type,
    });
});

// POST /admin/errors/clear — xóa toàn bộ log
router.post('/errors/clear', requireAdmin, (req, res) => {
    const db = getDb();
    const { type } = req.body;
    if (type) {
        db.prepare('DELETE FROM error_logs WHERE type = ?').run(type);
    } else {
        db.prepare('DELETE FROM error_logs').run();
    }
    const back = type ? `/admin/errors?type=${type}` : '/admin/errors';
    res.redirect(back);
});

// DELETE one log via AJAX
router.post('/api/errors/:id/delete', requireAdmin, (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM error_logs WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
});

// ===================================
// CDN DOMAIN POOL (Cloudflare multi-account)
// ===================================

// GET /admin/cdn — list CDN domains
router.get('/cdn', requireAdmin, (req, res) => {
    const db = getDb();
    const domains = db.prepare(`
        SELECT c.*, s.label as server_label, s.ip as server_ip
        FROM cdn_domains c LEFT JOIN servers s ON c.server_id = s.id
        ORDER BY c.created_at DESC
    `).all();
    const servers = db.prepare("SELECT id, label, ip FROM servers WHERE is_active=1 AND server_type='sftp' ORDER BY label").all();
    const jobs = db.prepare('SELECT * FROM cf_create_jobs ORDER BY created_at DESC LIMIT 20').all();
    res.render('admin/cdn-accounts', {
        title: 'CDN Domains (CF Pool)',
        domains, servers, jobs,
        msg: req.query.msg || null,
    });
});

// POST /admin/cdn/add — thêm domain thủ công
router.post('/cdn/add', requireAdmin, (req, res) => {
    const db = getDb();
    const { label, domain, server_id, cf_email, cf_api_token, cf_zone_id, note } = req.body;
    if (!domain) return res.redirect('/admin/cdn?msg=missing_domain');
    try {
        db.prepare(`
            INSERT INTO cdn_domains (label, domain, server_id, cf_email, cf_api_token, cf_zone_id, is_active, note)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        `).run(label || domain, domain.trim().toLowerCase(), server_id || null,
            cf_email || '', cf_api_token || '', cf_zone_id || '', note || '');
        res.redirect('/admin/cdn?msg=added');
    } catch (e) {
        res.redirect('/admin/cdn?msg=duplicate');
    }
});

// POST /admin/cdn/:id/edit — cập nhật domain (nhập API token, etc.)
router.post('/cdn/:id/edit', requireAdmin, async (req, res) => {
    const db = getDb();
    const { label, cf_api_token, cf_zone_id, note, server_id, hetzner_ip, do_cf_setup } = req.body;
    db.prepare(`
        UPDATE cdn_domains
        SET label=COALESCE(NULLIF(?,''),(SELECT label FROM cdn_domains WHERE id=?)),
            cf_api_token=COALESCE(NULLIF(?,''),(SELECT cf_api_token FROM cdn_domains WHERE id=?)),
            cf_zone_id=COALESCE(NULLIF(?,''),(SELECT cf_zone_id FROM cdn_domains WHERE id=?)),
            note=?, server_id=?
        WHERE id=?
    `).run(label, req.params.id, cf_api_token, req.params.id, cf_zone_id, req.params.id,
        note || '', server_id || null, req.params.id);

    // Nếu có API token mới và muốn thiết lập CF tự động
    if (do_cf_setup === '1' && cf_api_token && hetzner_ip) {
        const row = db.prepare('SELECT * FROM cdn_domains WHERE id=?').get(req.params.id);
        try {
            const { finalizeCfSetup } = require('../services/cfAutoCreate');
            await finalizeCfSetup(row.id, cf_api_token, hetzner_ip);
        } catch (e) {
            console.error('[CDN edit] finalizeCfSetup error:', e.message);
        }
    }
    res.redirect('/admin/cdn?msg=updated');
});

// POST /admin/cdn/:id/toggle — bật/tắt domain
router.post('/cdn/:id/toggle', requireAdmin, (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT is_active FROM cdn_domains WHERE id=?').get(req.params.id);
    if (!row) return res.json({ ok: false });
    db.prepare('UPDATE cdn_domains SET is_active=? WHERE id=?').run(row.is_active ? 0 : 1, req.params.id);
    res.json({ ok: true, is_active: !row.is_active });
});

// POST /admin/cdn/:id/delete
router.post('/cdn/:id/delete', requireAdmin, (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM cdn_domains WHERE id=?').run(req.params.id);
    res.redirect('/admin/cdn?msg=deleted');
});

// POST /admin/api/cdn/:id/test — test domain có trả về đúng Content-Type video/mp2t không
router.post('/api/cdn/:id/test', requireAdmin, async (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT domain FROM cdn_domains WHERE id=?').get(req.params.id);
    if (!row) return res.json({ ok: false, message: 'Không tìm thấy domain' });

    try {
        const { default: fetch } = await import('node-fetch');
        // Test bằng cách HEAD request một URL giả để xem header CF
        const testUrl = `https://${row.domain}/`;
        const r = await fetch(testUrl, { method: 'HEAD', redirect: 'follow', timeout: 10000 });
        const server = r.headers.get('server') || '';
        const cfRay = r.headers.get('cf-ray') || '';
        const ok = !!cfRay; // Có cf-ray header = đã qua Cloudflare
        res.json({
            ok,
            status: r.status,
            cf_ray: cfRay,
            server,
            message: ok ? 'Domain đang qua Cloudflare ✓' : 'Domain chưa qua Cloudflare hoặc không phản hồi',
        });
    } catch (e) {
        res.json({ ok: false, message: e.message });
    }
});

// --- SSE auto-create stream ---
// Map để gửi SSE events tới các client đang chờ
const sseClients = new Map(); // jobId → res

// GET /admin/cdn/create-stream?jobId=X — SSE stream cho job
router.get('/cdn/create-stream', requireAdmin, (req, res) => {
    const jobId = parseInt(req.query.jobId);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.set(jobId, res);
    req.on('close', () => sseClients.delete(jobId));

    // Gửi heartbeat mỗi 20s
    const hb = setInterval(() => res.write(': heartbeat\n\n'), 20000);
    req.on('close', () => clearInterval(hb));
});

function sendSse(jobId, event, data) {
    const client = sseClients.get(jobId);
    if (client) {
        client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
}

// POST /admin/cdn/auto-create — khởi tạo tạo tự động hàng loạt
router.post('/cdn/auto-create', requireAdmin, async (req, res) => {
    const db = getDb();
    const { server_id, hetzner_ip } = req.body;
    let domains = (req.body.domains || '').split('\n').map(d => d.trim().toLowerCase()).filter(Boolean);

    if (!domains.length) return res.redirect('/admin/cdn?msg=no_domains');

    const { createCloudflareAccount } = require('../services/cfAutoCreate');

    // Trả về ngay với danh sách jobId, browser sẽ subscribe SSE
    const jobIds = [];
    for (const domain of domains) {
        const jobRow = db.prepare(
            `INSERT INTO cf_create_jobs (domain, server_id, status, log) VALUES (?, ?, 'pending', '[]')`
        ).run(domain, server_id || null);
        jobIds.push({ domain, jobId: jobRow.lastInsertRowid });
    }

    // Chạy bất đồng bộ
    (async () => {
        for (const { domain, jobId } of jobIds) {
            db.prepare(`UPDATE cf_create_jobs SET status='running' WHERE id=?`).run(jobId);
            sendSse(jobId, 'start', { jobId, domain });

            const onLog = (msg) => {
                sendSse(jobId, 'log', { jobId, domain, msg });
            };

            const result = await createCloudflareAccount({
                domain, hetznerIp: hetzner_ip, serverId: server_id,
                label: domain, onLog,
            });

            const finalStatus = result.ok ? (result.status || 'done') : 'failed';
            db.prepare(`UPDATE cf_create_jobs SET status=? WHERE id=?`).run(finalStatus, jobId);
            sendSse(jobId, 'done', { jobId, domain, ok: result.ok, status: finalStatus, error: result.error });
        }
    })().catch(e => console.error('[AutoCreate batch error]', e.message));

    // Redirect về trang CDN với danh sách jobIds để browser có thể subscribe SSE
    const ids = jobIds.map(j => j.jobId).join(',');
    res.redirect(`/admin/cdn?msg=auto_create_started&jobs=${ids}`);
});



module.exports = router;
