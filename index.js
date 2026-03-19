const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const { getDb } = require('./database');
const { startServerCheckCron } = require('./services/serverCheck');
const { rateLimit } = require('./middleware/rateLimit');

const app = express();
const PORT = process.env.PORT || 3000;

// Cảnh báo nếu chưa set SESSION_SECRET
if (!process.env.SESSION_SECRET) {
    console.warn('⚠️  [SECURITY] SESSION_SECRET chưa được set! Sử dụng giá trị mặc định — KHÔNG AN TOÀN cho production.');
    console.warn('   Set biến môi trường: SESSION_SECRET=<random-string-dài-32-ký-tự>');
}

// Create required directories
['uploads/videos', 'uploads/thumbnails', 'storage/hls', 'data'].forEach(dir => {
    fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
});

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
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

app.use('/auth', rateLimit(10, 'rate_limit_login', 'Quá nhiều lần thử, vui lòng đợi 1 phút.'), authRoutes);
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
    let thumbUrl = thumbnailName || video.thumbnail || '';
    if (serverInfo) {
        const cdnBase = (serverInfo.cdn_url && serverInfo.cdn_url.trim())
            ? serverInfo.cdn_url.replace(/\/$/, '')
            : `http://${serverInfo.ip}:80`;
        m3u8Url = `${cdnBase}/hls/${videoId}/master.m3u8`;
        // Build full thumbnail URL from storage server
        if (thumbnailName) {
            thumbUrl = `${cdnBase}/thumbnails/${thumbnailName}`;
        }
    }
    const iframeUrl = m3u8Url ? `/embed/${videoId}` : '';
    db.prepare(`UPDATE videos SET m3u8_url=?, iframe_url=?, thumbnail=?, status='ready', progress=100,
        updated_at=datetime('now','localtime') WHERE id=?`)
        .run(m3u8Url, iframeUrl, thumbUrl, videoId);
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

// ── Public API v1 ──
const apiRouter = require('express').Router();

// Shared API token middleware — thay vì copy-paste 7 lần
function requireApiToken(req, res, next) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ error: 'Token bắt buộc' });
    const db = require('./database').getDb();
    const user = db.prepare('SELECT id FROM users WHERE api_token = ? AND is_active = 1').get(token);
    if (!user) return res.status(401).json({ error: 'Token không hợp lệ' });
    req.apiUser = user;
    next();
}
apiRouter.use(requireApiToken);
apiRouter.use(rateLimit(30, 'rate_limit_api', 'API rate limit exceeded.'));

apiRouter.get('/videos', (req, res) => {
    const db = require('./database').getDb();
    const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(100, parseInt(req.query.limit) || 20), offset = (page - 1) * limit;
    const videos = db.prepare(`SELECT id,title,description,thumbnail,m3u8_url,iframe_url,qualities,created_at FROM videos WHERE status='ready' AND visibility='public' ORDER BY sort_order DESC, created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM videos WHERE status='ready' AND visibility='public'`).get().cnt;
    res.json({ page, limit, total, videos });
});

apiRouter.get('/videos/:id', (req, res) => {
    const db = require('./database').getDb();
    const v = db.prepare(`SELECT id,title,description,thumbnail,m3u8_url,iframe_url,qualities,created_at FROM videos WHERE id=? AND status='ready' AND visibility='public'`).get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Không tìm thấy' });
    res.json(v);
});

apiRouter.get('/videos/:id/stream', (req, res) => {
    const db = require('./database').getDb();
    const v = db.prepare(`SELECT m3u8_url FROM videos WHERE id=? AND status='ready' AND visibility='public'`).get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Không tìm thấy' });
    // Sign URL nếu có secret key (fix #9 — tránh bypass signed URL)
    const { getSetting } = require('./database');
    const { signUrl } = require('./services/signedUrl');
    const secret = getSetting('signed_url_secret', '');
    const ttlHours = parseInt(getSetting('signed_url_ttl', '4'), 10);
    const url = secret ? signUrl(v.m3u8_url, secret, ttlHours * 3600) : v.m3u8_url;
    res.redirect(url);
});

// Normalize qualities: chấp nhận cả ['sd','hd'] và ['720p','1080p',...]
function normalizeQualities(raw) {
    const VALID = ['sd', 'hd', '360p', '480p', '720p', '1080p'];
    if (!raw) return ['sd'];
    const arr = Array.isArray(raw) ? raw : [raw];
    const filtered = arr.filter(q => VALID.includes(q));
    return filtered.length > 0 ? filtered : ['sd'];
}

// POST /api/v1/upload/url — Upload từ URL trực tiếp (MP4, MKV, ...)
// Non-blocking: trả response ngay, worker tự tải file từ sourceUrl
apiRouter.post('/upload/url', (req, res) => {
    const db = require('./database').getDb();
    const { url, title, description, server_id, qualities, visibility } = req.body;
    if (!url) return res.status(400).json({ error: 'Thiếu tham số: url' });
    if (!title) return res.status(400).json({ error: 'Thiếu tham số: title' });
    // Auto-select server nếu không có server_id: chọn server active có ít video nhất
    let resolvedServerId = server_id;
    if (!resolvedServerId) {
        const auto = db.prepare(`
            SELECT s.id FROM servers s
            LEFT JOIN videos v ON v.server_id = s.id
            WHERE s.is_active = 1
            GROUP BY s.id
            ORDER BY COUNT(v.id) ASC
            LIMIT 1`).get();
        if (!auto) return res.status(400).json({ error: 'Không có server nào active' });
        resolvedServerId = auto.id;
    } else {
        const server = db.prepare('SELECT id FROM servers WHERE id=? AND is_active=1').get(resolvedServerId);
        if (!server) return res.status(400).json({ error: 'server_id không hợp lệ' });
    }

    // Dedup: nếu URL đã tồn tại thì trả về video cũ
    const existing = db.prepare('SELECT id, status, m3u8_url, iframe_url FROM videos WHERE video_file=?').get(url);
    if (existing) {
        return res.json({ ok: true, video_id: existing.id, status: existing.status, m3u8_url: existing.m3u8_url, iframe_url: existing.iframe_url, already_exists: true, message: 'URL này đã được upload trước đó, trả về video hiện có.' });
    }

    try {
        const { encodeQueue } = require('./services/queue');
        const q = normalizeQualities(qualities);
        const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM videos').get().m;
        // Lưu url vào video_file để dedup về sau
        const ins = db.prepare(`INSERT INTO videos (title,description,video_file,server_id,uploaded_by,status,qualities,visibility,sort_order) VALUES (?,?,?,?,?,'queued',?,?,?)`);
        const row = ins.run(title, description || '', url, resolvedServerId, req.apiUser.id, JSON.stringify(q), visibility || 'public', maxOrder + 1);
        const videoId = row.lastInsertRowid;
        encodeQueue.push({ videoId, videoFilePath: null, videoFileName: null, autoThumb: true, qualities: q, sourceUrl: url });
        res.json({ ok: true, video_id: videoId, server_id: resolvedServerId, status: 'queued', message: 'Video đã được thêm vào hàng đợi xử lý.' });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/v1/upload/drive — Upload từ Google Drive URL
// Non-blocking: trả response ngay, worker tự tải file từ sourceUrl
apiRouter.post('/upload/drive', (req, res) => {
    const db = require('./database').getDb();
    const { drive_url, title, description, server_id, qualities, visibility } = req.body;
    if (!drive_url) return res.status(400).json({ error: 'Thiếu tham số: drive_url' });
    if (!title) return res.status(400).json({ error: 'Thiếu tham số: title' });
    // Auto-select server nếu không có server_id
    let resolvedServerId = server_id;
    if (!resolvedServerId) {
        const auto = db.prepare(`
            SELECT s.id FROM servers s
            LEFT JOIN videos v ON v.server_id = s.id
            WHERE s.is_active = 1
            GROUP BY s.id
            ORDER BY COUNT(v.id) ASC
            LIMIT 1`).get();
        if (!auto) return res.status(400).json({ error: 'Không có server nào active' });
        resolvedServerId = auto.id;
    } else {
        const server = db.prepare('SELECT id FROM servers WHERE id=? AND is_active=1').get(resolvedServerId);
        if (!server) return res.status(400).json({ error: 'server_id không hợp lệ' });
    }

    // Validate và extract Drive file ID
    const driveMatch = drive_url.match(/(?:\/d\/|id=)([a-zA-Z0-9_-]{25,})/);
    if (!driveMatch) {
        return res.status(400).json({ error: 'drive_url không hợp lệ. Phải là link chia sẻ Google Drive.' });
    }
    const fileId = driveMatch[1];
    const sourceUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

    // Dedup: nếu Drive file ID đã tồn tại thì trả về video cũ
    const existing = db.prepare("SELECT id, status, m3u8_url, iframe_url FROM videos WHERE video_file LIKE ?").get(`%id=${fileId}%`);
    if (existing) {
        return res.json({ ok: true, video_id: existing.id, status: existing.status, m3u8_url: existing.m3u8_url, iframe_url: existing.iframe_url, already_exists: true, message: 'File Drive này đã được upload trước đó, trả về video hiện có.' });
    }

    try {
        const { encodeQueue } = require('./services/queue');
        const q = normalizeQualities(qualities);
        const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM videos').get().m;
        // Lưu sourceUrl vào video_file để dedup về sau
        const ins = db.prepare(`INSERT INTO videos (title,description,video_file,server_id,uploaded_by,status,qualities,visibility,sort_order) VALUES (?,?,?,?,?,'queued',?,?,?)`);
        const row = ins.run(title, description || '', sourceUrl, resolvedServerId, req.apiUser.id, JSON.stringify(q), visibility || 'public', maxOrder + 1);
        const videoId = row.lastInsertRowid;
        encodeQueue.push({ videoId, videoFilePath: null, videoFileName: null, autoThumb: true, qualities: q, sourceUrl });
        res.json({ ok: true, video_id: videoId, server_id: resolvedServerId, status: 'queued', message: 'Video từ Google Drive đã được thêm vào hàng đợi.' });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/v1/upload/:id/status — Kiểm tra trạng thái xử lý video
apiRouter.get('/upload/:id/status', (req, res) => {
    const db = require('./database').getDb();
    const v = db.prepare('SELECT id,title,status,progress,m3u8_url,iframe_url,created_at FROM videos WHERE id=?').get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Không tìm thấy video' });
    res.json(v);
});

app.use('/api/v1', apiRouter);



// Home redirect
app.get('/', (req, res) => {
    res.redirect('/admin/videos');
});

// Global error handler — tránh leak stack trace
app.use((err, req, res, next) => {
    console.error('[Global Error]', err.message, err.stack);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal Server Error' });
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
