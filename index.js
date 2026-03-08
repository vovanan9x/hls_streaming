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

// Make currentUser available to all templates
app.use((req, res, next) => {
    res.locals.currentUser = req.session ? req.session.user || null : null;
    next();
});

// Routes
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/user');

app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
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
