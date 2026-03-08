const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb, getSetting, setSetting } = require('../database');
const { convertToHLS, generateThumbnail } = require('../services/ffmpeg');
const { downloadRemoteFile, UPLOAD_DIR, THUMB_DIR } = require('../services/upload');
const { requireAuth, requireAdmin, requireUploader } = require('../middleware/auth');
const { uploadHlsToServer } = require('../services/sftp');
const { getAllViewerCounts } = require('../services/viewers');
const { encodeQueue } = require('../services/queue');
const r2 = require('../services/r2');

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

// =============================
// VIDEO ROUTES
// =============================

// GET /admin/upload - Upload video page (uploader + admin)
router.get('/upload', requireUploader, (req, res) => {
    const db = getDb();
    const servers = db.prepare('SELECT * FROM servers WHERE is_active = 1 ORDER BY label').all();
    res.render('admin/upload', { title: 'Upload Video', servers, error: null, success: null });
});

// POST /admin/upload - Handle video upload (uploader + admin)
router.post('/upload', requireUploader, (req, res) => {
    const uploadFields = upload.fields([
        { name: 'video', maxCount: 1 }
    ]);

    uploadFields(req, res, async (err) => {
        const db = getDb();
        const servers = db.prepare('SELECT * FROM servers WHERE is_active = 1 ORDER BY label').all();

        if (err) {
            return res.render('admin/upload', { title: 'Upload Video', servers, error: err.message, success: null });
        }

        try {
            const { title, description, upload_type, remote_url, server_id, thumb_mode } = req.body;

            if (!title || !title.trim()) {
                return res.render('admin/upload', { title: 'Upload Video', servers, error: 'Vui lòng nhập tiêu đề video', success: null });
            }

            let videoFilePath, videoFileName;

            if (upload_type === 'remote' && remote_url) {
                try {
                    const result = await downloadRemoteFile(remote_url, 'video.mp4');
                    videoFilePath = result.filePath;
                    videoFileName = result.fileName;
                } catch (dlErr) {
                    return res.render('admin/upload', { title: 'Upload Video', servers, error: `Lỗi tải file remote: ${dlErr.message}`, success: null });
                }
            } else if (req.files && req.files.video && req.files.video[0]) {
                videoFilePath = req.files.video[0].path;
                videoFileName = req.files.video[0].filename;
            } else {
                return res.render('admin/upload', { title: 'Upload Video', servers, error: 'Vui lòng chọn file video hoặc nhập URL', success: null });
            }

            const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM videos').get();

            // Parse qualities from form — expect an array like ['360p','720p']
            let qualities = req.body.qualities;
            if (!qualities) qualities = ['720p'];
            if (!Array.isArray(qualities)) qualities = [qualities];
            const validQualities = ['360p', '480p', '720p', '1080p'];
            qualities = qualities.filter(q => validQualities.includes(q));
            if (qualities.length === 0) qualities = ['720p'];
            const qualitiesJson = JSON.stringify(qualities);

            const result = db.prepare(`
        INSERT INTO videos (title, description, video_file, server_id, uploaded_by, status, qualities, visibility, sort_order)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(title.trim(), description || '', videoFileName, server_id || null, req.session.user.id, qualitiesJson, req.body.visibility || 'public', maxOrder.max_order + 1);

            const videoId = result.lastInsertRowid;
            const queuePos = encodeQueue.push({ videoId, videoFilePath, videoFileName, autoThumb: thumb_mode !== 'upload', qualities });


            const queueMsg = queuePos === 0 && !encodeQueue.running
                ? 'Đang xử lý ngay...'
                : `Trong hàng đợi (vị trí ${encodeQueue.size})...`;
            return res.render('admin/upload', {
                title: 'Upload Video',
                servers,
                error: null,
                success: `Video "${title}" đã được upload! ${queueMsg}`
            });

        } catch (e) {
            console.error('[Upload Error]', e);
            return res.render('admin/upload', { title: 'Upload Video', servers, error: `Lỗi server: ${e.message}`, success: null });
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
 * Process video: multi-quality HLS encode → R2 / SFTP / local
 */
async function processVideo(videoId, videoFilePath, videoFileName, autoThumb = true, qualities = ['720p']) {
    const db = getDb();
    const STORAGE_DIR = path.join(__dirname, '..', 'storage');

    try {
        // Mark as processing
        db.prepare("UPDATE videos SET status = 'processing', progress = 0 WHERE id = ?").run(videoId);

        const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
        const serverInfo = video && video.server_id
            ? db.prepare('SELECT * FROM servers WHERE id = ?').get(video.server_id) : null;

        if (!qualities || qualities.length === 0) {
            try { qualities = JSON.parse(video.qualities || '["720p"]'); } catch (e) { qualities = ['720p']; }
        }

        // Step 1: Encode HLS locally
        const localHlsBase = path.join(STORAGE_DIR, 'hls');
        fs.mkdirSync(localHlsBase, { recursive: true });
        let lastPercent = -1;
        await convertToHLS(videoFilePath, localHlsBase, videoId.toString(), qualities, (pct) => {
            if (pct > lastPercent) { lastPercent = pct; db.prepare('UPDATE videos SET progress = ? WHERE id = ?').run(pct, videoId); }
        });

        const localHlsDir = path.join(localHlsBase, videoId.toString());
        let m3u8Url;
        const iframeUrl = `/embed/${videoId}`;

        // Step 2: Upload (R2 preferred → SFTP → local fallback)
        db.prepare("UPDATE videos SET status = 'uploading', progress = 99 WHERE id = ?").run(videoId);

        if (r2.isConfigured()) {
            try {
                m3u8Url = await r2.uploadFolder(localHlsDir, `hls/${videoId}`);
                console.log(`[R2] Upload complete: ${m3u8Url}`);
            } catch (r2Err) {
                console.error('[R2] Upload failed, falling back:', r2Err.message);
                m3u8Url = `/storage/hls/${videoId}/master.m3u8`;
            }
        } else if (serverInfo) {
            try {
                await uploadHlsToServer(serverInfo, localHlsDir, videoId.toString());
                const remoteBase = serverInfo.storage_path.replace(/\/$/, '');
                m3u8Url = `http://${serverInfo.ip}:80${remoteBase}/${videoId}/master.m3u8`;
            } catch (sftpErr) {
                console.error('[SFTP] Upload failed, falling back:', sftpErr.message);
                m3u8Url = `/storage/hls/${videoId}/master.m3u8`;
            }
        } else {
            m3u8Url = `/storage/hls/${videoId}/master.m3u8`;
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
        db.prepare("UPDATE videos SET status='error', updated_at=datetime('now','localtime') WHERE id=?").run(videoId);
    }
}

// Wire the queue processor
encodeQueue.setProcessor(processVideo);
// Load R2 config from DB settings on startup
(function loadR2Config() {
    try {
        const db = getDb();
        const cfg = {
            accountId: db.prepare("SELECT value FROM settings WHERE key='r2_account_id'").get()?.value,
            accessKeyId: db.prepare("SELECT value FROM settings WHERE key='r2_access_key'").get()?.value,
            secretAccessKey: db.prepare("SELECT value FROM settings WHERE key='r2_secret_key'").get()?.value,
            bucket: db.prepare("SELECT value FROM settings WHERE key='r2_bucket'").get()?.value,
            publicUrl: db.prepare("SELECT value FROM settings WHERE key='r2_public_url'").get()?.value,
        };
        if (cfg.accountId && cfg.accessKeyId && cfg.bucket) r2.init(cfg);
    } catch (e) { /* DB not ready yet — will init when settings saved */ }
})();



// GET /admin/videos - Video management list (admin only for full list; uploader sees own + m3u8 links)
router.get('/videos', (req, res) => {
    const db = getDb();
    const user = req.session.user;

    let videos;
    if (user.role === 'administrator') {
        videos = db.prepare(`
      SELECT v.*, s.label as server_label, u.username as uploader_name
      FROM videos v 
      LEFT JOIN servers s ON v.server_id = s.id 
      LEFT JOIN users u ON v.uploaded_by = u.id
      ORDER BY v.sort_order DESC, v.created_at DESC
    `).all();
    } else {
        // Uploader: only see their own videos
        videos = db.prepare(`
      SELECT v.*, s.label as server_label, u.username as uploader_name
      FROM videos v 
      LEFT JOIN servers s ON v.server_id = s.id 
      LEFT JOIN users u ON v.uploaded_by = u.id
      WHERE v.uploaded_by = ?
      ORDER BY v.sort_order DESC, v.created_at DESC
    `).all(user.id);
    }
    res.render('admin/videos', { title: 'Quản lí Video', videos });
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

// POST /admin/videos/:id/push-top - Push video to top (admin only)
router.post('/videos/:id/push-top', requireAdmin, (req, res) => {
    const db = getDb();
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM videos').get();
    db.prepare(`
    UPDATE videos SET sort_order = ?, updated_at = datetime('now','localtime') WHERE id = ?
  `).run(maxOrder.max_order + 1, req.params.id);
    res.redirect('/admin/videos');
});

// =============================
// SERVER ROUTES (admin only)
// =============================

router.get('/servers', requireAdmin, (req, res) => {
    const db = getDb();
    const servers = db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all();
    res.render('admin/servers', { title: 'Quản lí Server', servers });
});

router.get('/servers/add', requireAdmin, (req, res) => {
    res.render('admin/server-form', { title: 'Thêm Server', server: null, error: null, success: null });
});

router.post('/servers/add', requireAdmin, (req, res) => {
    const db = getDb();
    const { label, ip, port, username, password, storage_path } = req.body;

    if (!label || !ip || !username) {
        return res.render('admin/server-form', {
            title: 'Thêm Server',
            server: req.body,
            error: 'Vui lòng điền đầy đủ: Label, IP, Username',
            success: null
        });
    }

    db.prepare(`
    INSERT INTO servers (label, ip, port, username, password, storage_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(label, ip, parseInt(port) || 22, username, password || '', storage_path || '/var/hls-storage');

    res.redirect('/admin/servers');
});

router.get('/servers/:id/edit', requireAdmin, (req, res) => {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.redirect('/admin/servers');
    res.render('admin/server-form', { title: 'Sửa Server', server, error: null, success: null });
});

router.post('/servers/:id/edit', requireAdmin, (req, res) => {
    const db = getDb();
    const { label, ip, port, username, password, storage_path } = req.body;

    db.prepare(`
    UPDATE servers 
    SET label = ?, ip = ?, port = ?, username = ?, password = ?, storage_path = ?, updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(label, ip, parseInt(port) || 22, username, password || '', storage_path || '/var/hls-storage', req.params.id);

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
    const r2Configured = r2.isConfigured();
    const r2Cfg = r2.getConfig() || {};
    const user = db.prepare('SELECT api_token FROM users WHERE id = ?').get(req.session.user.id);
    res.render('admin/settings', {
        title: 'Cài đặt Hệ thống',
        r2Configured, r2Cfg,
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

module.exports = router;

