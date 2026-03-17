const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const { getDb } = require('./database');
const { startServerCheckCron } = require('./services/serverCheck');

const app = express();
const PORT = process.env.PORT || 3000;

// Create required directories
['uploads/videos', 'uploads/thumbnails', 'storage/hls', 'data'].forEach(dir => {
    fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
});

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/storage', express.static(path.join(__dirname, 'storage')));

// Session (dùng biến môi trường SESSION_SECRET trong production)
app.use(session({
    secret: process.env.SESSION_SECRET || 'hls-streaming-secret-key-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Make currentUser & pendingDeleteCount available to all templates
app.use((req, res, next) => {
    res.locals.currentUser = req.session ? req.session.user || null : null;
    // Badge số lượng yêu cầu xoá pending cho sidebar admin
    if (req.session && req.session.user && req.session.user.role === 'administrator') {
        try {
            const db = getDb();
            const row = db.prepare(`SELECT COUNT(*) as cnt FROM delete_requests WHERE status='pending'`).get();
            res.locals.pendingDeleteCount = row ? row.cnt : 0;
        } catch (e) {
            res.locals.pendingDeleteCount = 0;
        }
    } else {
        res.locals.pendingDeleteCount = 0;
    }
    next();
});

// Routes
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/user');

app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);

// ── Worker callback endpoints (OUTSIDE /admin to avoid auth/nginx issues) ──
const workerCallbackRouter = require('express').Router();
const workerPoolForCallback = require('./services/workerPool');

function workerTokenAuth(req, res, next) {
    const token = req.headers['x-worker-token'];
    const workers = workerPoolForCallback.getWorkers();
    if (workers.some(w => w.token === token)) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

workerCallbackRouter.post('/progress', workerTokenAuth, (req, res) => {
    const { videoId, progress } = req.body;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });
    console.log(`[Worker Callback] Progress: videoId=${videoId} progress=${progress}`);
    const db = getDb();
    db.prepare(`UPDATE videos SET progress=?, status='processing', updated_at=datetime('now','localtime') WHERE id=?`)
        .run(Math.min(progress || 0, 99), videoId);
    res.json({ ok: true });
});

workerCallbackRouter.post('/done', workerTokenAuth, (req, res) => {
    const { videoId, thumbnailName } = req.body;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });
    console.log(`[Worker Callback] DONE: videoId=${videoId} thumbnail=${thumbnailName}`);
    const db = getDb();
    const video = db.prepare('SELECT * FROM videos WHERE id=?').get(videoId);
    if (!video) return res.status(404).json({ error: 'Video not found' });
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
    const { encodeQueue } = require('./services/queue');
    encodeQueue.markRemoteDone(videoId);
    console.log(`[Worker Callback] Video ${videoId} DONE → ${m3u8Url}`);
    res.json({ ok: true });
});

workerCallbackRouter.post('/error', workerTokenAuth, (req, res) => {
    const { videoId, error } = req.body;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });
    console.log(`[Worker Callback] ERROR: videoId=${videoId} error=${error}`);
    const db = getDb();
    const video = db.prepare('SELECT title FROM videos WHERE id=?').get(videoId);
    db.prepare(`UPDATE videos SET status='error', updated_at=datetime('now','localtime') WHERE id=?`).run(videoId);
    const { addErrorLog } = require('./database');
    addErrorLog('encoding', {
        videoId, videoTitle: video ? video.title : '',
        message: error || 'Unknown worker error',
    });
    const { encodeQueue } = require('./services/queue');
    encodeQueue.markRemoteDone(videoId);
    res.json({ ok: true });
});

app.use('/api/worker', workerCallbackRouter);

app.use('/', userRoutes);

// Public API v1 (same handlers registered in adminRoutes via relative paths)
const apiRouter = require('express').Router();
apiRouter.get('/videos', (req, res) => {
    const auth = req.headers['authorization'] || ''; const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ error: 'Token bắt buộc' });
    const db = require('./database').getDb();
    const user = db.prepare('SELECT id FROM users WHERE api_token = ? AND is_active = 1').get(token);
    if (!user) return res.status(401).json({ error: 'Token không hợp lệ' });
    const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(100, parseInt(req.query.limit) || 20), offset = (page - 1) * limit;
    const videos = db.prepare(`SELECT id,title,description,thumbnail,m3u8_url,iframe_url,qualities,created_at FROM videos WHERE status='ready' AND visibility='public' ORDER BY sort_order DESC, created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM videos WHERE status='ready' AND visibility='public'`).get().cnt;
    res.json({ page, limit, total, videos });
});
apiRouter.get('/videos/:id', (req, res) => {
    const auth = req.headers['authorization'] || ''; const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ error: 'Token bắt buộc' });
    const db = require('./database').getDb();
    if (!db.prepare('SELECT id FROM users WHERE api_token=? AND is_active=1').get(token)) return res.status(401).json({ error: 'Token không hợp lệ' });
    const v = db.prepare(`SELECT id,title,description,thumbnail,m3u8_url,iframe_url,qualities,created_at FROM videos WHERE id=? AND status='ready' AND visibility='public'`).get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Không tìm thấy' });
    res.json(v);
});
apiRouter.get('/videos/:id/stream', (req, res) => {
    const auth = req.headers['authorization'] || ''; const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ error: 'Token bắt buộc' });
    const db = require('./database').getDb();
    if (!db.prepare('SELECT id FROM users WHERE api_token=? AND is_active=1').get(token)) return res.status(401).json({ error: 'Token không hợp lệ' });
    const v = db.prepare(`SELECT m3u8_url FROM videos WHERE id=? AND status='ready' AND visibility='public'`).get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Không tìm thấy' });
    res.redirect(v.m3u8_url);
});

// POST /api/v1/upload/url — Upload từ URL trực tiếp (MP4, MKV, ...)
apiRouter.post('/upload/url', async (req, res) => {
    const auth = req.headers['authorization'] || ''; const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ error: 'Token bắt buộc' });
    const db = require('./database').getDb();
    const user = db.prepare('SELECT id FROM users WHERE api_token=? AND is_active=1').get(token);
    if (!user) return res.status(401).json({ error: 'Token không hợp lệ' });

    const { url, title, description, server_id, qualities, visibility, folder_id } = req.body;
    if (!url) return res.status(400).json({ error: 'Thiếu tham số: url' });
    if (!title) return res.status(400).json({ error: 'Thiếu tham số: title' });
    if (!server_id) return res.status(400).json({ error: 'Thiếu tham số: server_id' });

    const server = db.prepare('SELECT id FROM servers WHERE id=? AND is_active=1').get(server_id);
    if (!server) return res.status(400).json({ error: 'server_id không hợp lệ' });

    try {
        const { downloadRemoteFile } = require('./services/upload');
        const { encodeQueue } = require('./services/queue');
        const result = await downloadRemoteFile(url, 'video.mp4');
        const q = qualities ? (Array.isArray(qualities) ? qualities : [qualities]) : ['720p'];
        const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM videos').get().m;
        const ins = db.prepare(`INSERT INTO videos (title,description,video_file,server_id,uploaded_by,status,qualities,visibility,sort_order) VALUES (?,?,?,?,?,'queued',?,?,?)`);
        const row = ins.run(title, description || '', result.fileName, server_id, user.id, JSON.stringify(q), visibility || 'public', maxOrder + 1);
        encodeQueue.push({ videoId: row.lastInsertRowid, videoFilePath: result.filePath, videoFileName: result.fileName, autoThumb: true, qualities: q });
        res.json({ ok: true, video_id: row.lastInsertRowid, status: 'queued', message: 'Video đã được thêm vào hàng đợi xử lý.' });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/v1/upload/drive — Upload từ Google Drive URL
apiRouter.post('/upload/drive', async (req, res) => {
    const auth = req.headers['authorization'] || ''; const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ error: 'Token bắt buộc' });
    const db = require('./database').getDb();
    const user = db.prepare('SELECT id FROM users WHERE api_token=? AND is_active=1').get(token);
    if (!user) return res.status(401).json({ error: 'Token không hợp lệ' });

    const { drive_url, title, description, server_id, qualities, visibility } = req.body;
    if (!drive_url) return res.status(400).json({ error: 'Thiếu tham số: drive_url' });
    if (!title) return res.status(400).json({ error: 'Thiếu tham số: title' });
    if (!server_id) return res.status(400).json({ error: 'Thiếu tham số: server_id' });

    const server = db.prepare('SELECT id FROM servers WHERE id=? AND is_active=1').get(server_id);
    if (!server) return res.status(400).json({ error: 'server_id không hợp lệ' });

    // Chuyển link Drive sang link download trực tiếp
    let directUrl = drive_url;
    const driveMatch = drive_url.match(/(?:\/d\/|id=)([a-zA-Z0-9_-]{25,})/);
    if (driveMatch) {
        const fileId = driveMatch[1];
        directUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
    } else {
        return res.status(400).json({ error: 'drive_url không hợp lệ. Phải là link chia sẻ Google Drive.' });
    }

    try {
        const { downloadRemoteFile } = require('./services/upload');
        const { encodeQueue } = require('./services/queue');
        const result = await downloadRemoteFile(directUrl, 'drive-video.mp4');
        const q = qualities ? (Array.isArray(qualities) ? qualities : [qualities]) : ['720p'];
        const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM videos').get().m;
        const ins = db.prepare(`INSERT INTO videos (title,description,video_file,server_id,uploaded_by,status,qualities,visibility,sort_order) VALUES (?,?,?,?,?,'queued',?,?,?)`);
        const row = ins.run(title, description || '', result.fileName, server_id, user.id, JSON.stringify(q), visibility || 'public', maxOrder + 1);
        encodeQueue.push({ videoId: row.lastInsertRowid, videoFilePath: result.filePath, videoFileName: result.fileName, autoThumb: true, qualities: q });
        res.json({ ok: true, video_id: row.lastInsertRowid, status: 'queued', message: 'Video từ Google Drive đã được thêm vào hàng đợi.' });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/v1/upload/:id/status — Kiểm tra trạng thái xử lý video
apiRouter.get('/upload/:id/status', (req, res) => {
    const auth = req.headers['authorization'] || ''; const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ error: 'Token bắt buộc' });
    const db = require('./database').getDb();
    if (!db.prepare('SELECT id FROM users WHERE api_token=? AND is_active=1').get(token)) return res.status(401).json({ error: 'Token không hợp lệ' });
    const v = db.prepare('SELECT id,title,status,progress,m3u8_url,iframe_url,created_at FROM videos WHERE id=?').get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Không tìm thấy video' });
    res.json(v);
});

app.use('/api/v1', apiRouter);



// Home redirect
app.get('/', (req, res) => {
    res.redirect('/admin/videos');
});

// Initialize database
getDb();

// Start server health check cron
startServerCheckCron();

// Start server
app.listen(PORT, () => {
    console.log(`🎬 HLS Streaming Server đang chạy tại http://localhost:${PORT}`);
    console.log(`   Login: http://localhost:${PORT}/auth/login`);
    console.log(`   Admin: http://localhost:${PORT}/admin/videos`);
});
