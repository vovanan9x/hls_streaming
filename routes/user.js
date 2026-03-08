const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../database');
const { pingViewer } = require('../services/viewers');
const { proxyFetch, allowDomain } = require('../services/hlsProxy');

// GET /proxy/hls - Proxy m3u8/ts để tránh CORS (R2, CDN)
router.get('/proxy/hls', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('Thiếu tham số url');
    const proxyPath = req.protocol + '://' + req.get('host') + req.path + '?url=';
    try {
        const { data, contentType } = await proxyFetch(url, proxyPath);
        res.set('Content-Type', contentType);
        res.set('Cache-Control', url.includes('.m3u8') ? 'no-cache' : 'public, max-age=3600');
        res.send(data);
    } catch (e) {
        console.error('[Proxy]', e.message);
        res.status(502).send('Lỗi proxy: ' + e.message);
    }
});

// GET /embed/:videoId - Embed player by video ID (chỉ video ready + public)
router.get('/embed/:videoId', (req, res) => {
    const db = getDb();
    const video = db.prepare('SELECT * FROM videos WHERE id = ? AND status = ? AND visibility = ?')
        .get(req.params.videoId, 'ready', 'public');

    if (!video || !video.m3u8_url) {
        return res.status(404).render('user/player', {
            title: 'Video không tồn tại',
            m3u8Url: null,
            videoTitle: 'Video không tồn tại',
            videoId: null,
            error: 'Video không tồn tại hoặc chưa sẵn sàng.'
        });
    }

    let m3u8Url = video.m3u8_url;
    // URL ngoài (R2, CDN): dùng proxy để tránh CORS khi phát từ localhost
    if (m3u8Url.startsWith('http://') || m3u8Url.startsWith('https://')) {
        try {
            const u = new URL(m3u8Url);
            allowDomain(u.hostname);
        } catch (_) {}
        m3u8Url = '/proxy/hls?url=' + encodeURIComponent(m3u8Url);
    }

    res.render('user/player', {
        title: video.title,
        m3u8Url,
        videoTitle: video.title,
        videoId: video.id,
        error: null
    });
});

// GET /play - Play video by m3u8 URL query param
router.get('/play', (req, res) => {
    const { url, id } = req.query;

    if (!url) {
        return res.status(400).render('user/player', {
            title: 'Player',
            m3u8Url: null,
            videoTitle: 'HLS Player',
            videoId: null,
            error: 'Vui lòng cung cấp URL m3u8. Ví dụ: /play?url=https://example.com/video/index.m3u8'
        });
    }

    let m3u8Url = url;
    if (m3u8Url.startsWith('http://') || m3u8Url.startsWith('https://')) {
        try {
            const u = new URL(m3u8Url);
            allowDomain(u.hostname);
        } catch (_) {}
        m3u8Url = '/proxy/hls?url=' + encodeURIComponent(m3u8Url);
    }

    res.render('user/player', {
        title: 'HLS Player',
        m3u8Url,
        videoTitle: 'HLS Player',
        videoId: id || null,
        error: null
    });
});

// POST /api/viewer/ping
router.post('/api/viewer/ping', (req, res) => {
    const { videoId } = req.body;
    if (!videoId) return res.json({ ok: false });

    const sessionKey = crypto.createHash('md5')
        .update((req.ip || '') + (req.headers['user-agent'] || ''))
        .digest('hex');

    pingViewer(videoId, sessionKey);

    // Upsert into view_logs for analytics
    try {
        const db = getDb();
        const existing = db.prepare('SELECT id FROM view_logs WHERE video_id = ? AND session_key = ? AND started_at >= DATE("now", "-1 day")').get(videoId, sessionKey);
        if (existing) {
            db.prepare('UPDATE view_logs SET last_ping = datetime("now","localtime") WHERE id = ?').run(existing.id);
        } else {
            db.prepare('INSERT INTO view_logs (video_id, session_key, ip) VALUES (?, ?, ?)').run(videoId, sessionKey, req.ip || '');
        }
    } catch (e) { /* non-critical */ }

    res.json({ ok: true });
});

module.exports = router;
