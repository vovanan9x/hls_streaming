const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb, getSetting } = require('../database');
const { signUrl } = require('../services/signedUrl');
const { pingViewer } = require('../services/viewers');

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
            videoFile: '',
            error: 'Video không tồn tại hoặc chưa sẵn sàng.'
        });
    }

    // Sign URL nếu có secret key
    const secret = getSetting('signed_url_secret', '');
    const ttlHours = parseInt(getSetting('signed_url_ttl', '4'), 10);
    const m3u8Url = secret ? signUrl(video.m3u8_url, secret, ttlHours * 3600) : video.m3u8_url;

    // Cache embed page 30s (stale-while-revalidate cho CDN edge)
    // Không cache nếu có signed URL (token thay đổi mỗi request)
    if (!secret) {
        res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    } else {
        res.setHeader('Cache-Control', 'private, no-store');
    }
    res.render('user/player', {
        title: video.title,
        m3u8Url,
        videoTitle: video.title,
        videoId: video.id,
        videoFile: video.video_file || '',
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
            videoFile: '',
            error: 'Vui lòng cung cấp URL m3u8. Ví dụ: /play?url=https://example.com/video/index.m3u8'
        });
    }

    // Sign URL nếu có secret key
    const secret = getSetting('signed_url_secret', '');
    const ttlHours = parseInt(getSetting('signed_url_ttl', '4'), 10);
    const m3u8Url = secret ? signUrl(url, secret, ttlHours * 3600) : url;

    res.render('user/player', {
        title: 'HLS Player',
        m3u8Url,
        videoTitle: 'HLS Player',
        videoId: id || null,
        videoFile: '',
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
