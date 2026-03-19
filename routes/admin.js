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
const { uploadHlsToServer, deleteVideoFromStorage } = require('../services/sftp');
const { getAllViewerCounts } = require('../services/viewers');
const { encodeQueue } = require('../services/queue');
const workerPool = require('../services/workerPool');
const { pickLeastLoadedServer, getServerStats } = require('../services/serverRouter');
const { purgeVideoCache } = require('../services/cfCache');

// In-memory SFTP upload progress: videoId -> { done, total, file }
const sftpProgress = new Map();

// In-memory remote download progress: trackId -> { downloaded, total, percent, speed, done, error }
const downloadProgress = new Map();

/** Read configurable page size from settings, default 20 */
function getPageSize() {
    const raw = getSetting('admin_page_size');
    const n = parseInt(raw);
    return (!isNaN(n) && n >= 5 && n <= 200) ? n : 20;
}


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
    const leastLoaded = servers.length > 0 ? pickLeastLoadedServer() : null;
    res.render('admin/upload', { title: 'Upload Video', servers, noServers, leastLoaded, error: null, success: null });
});

// GET /admin/upload/download-progress — poll remote download progress
router.get('/upload/download-progress', requireUploader, (req, res) => {
    const trackId = req.query.trackId;
    if (!trackId || !downloadProgress.has(trackId)) {
        return res.json({ percent: -1 }); // no data
    }
    const p = downloadProgress.get(trackId);
    if (p.done) {
        // Cleanup after client reads final state
        setTimeout(() => downloadProgress.delete(trackId), 5000);
    }
    res.json(p);
});

// POST /admin/upload - Handle video upload (uploader + admin)
router.post('/upload', requireUploader, (req, res) => {
    const uploadFields = upload.fields([{ name: 'video', maxCount: 1 }]);
    uploadFields(req, res, async (err) => {
        const db = getDb();
        const servers = db.prepare('SELECT * FROM servers WHERE is_active = 1 ORDER BY label').all();
        const noServers = servers.length === 0;
        const leastLoaded = servers.length > 0 ? pickLeastLoadedServer() : null;

        // Helper để render lại form với lỗi
        const renderError = (msg) => res.render('admin/upload', {
            title: 'Upload Video', servers, noServers, leastLoaded, error: msg, success: null
        });

        if (err) {
            return renderError(err.message);
        }

        try {
            const { title, description, upload_type, remote_url, server_id, thumb_mode } = req.body;

            if (!title || !title.trim()) {
                return renderError('Vui lòng nhập tiêu đề video');
            }
            if (!server_id) {
                return renderError('Vui lòng chọn server lưu trữ. Nếu chưa có server, hãy thêm server trước.');
            }

            // Auto-pick: chọn server ít phim nhất
            let resolvedServerId = server_id;
            if (server_id === 'auto') {
                const auto = pickLeastLoadedServer();
                if (!auto) return renderError('Không có server nào khả dụng.');
                resolvedServerId = auto.id;
            }

            const selectedServer = db.prepare('SELECT * FROM servers WHERE id = ? AND is_active = 1').get(resolvedServerId);
            if (!selectedServer) {
                return renderError('Server không hợp lệ hoặc đã bị vô hiệu hoá.');
            }

            let videoFilePath, videoFileName;

            // Track download progress for remote/gdrive uploads
            const trackId = req.body.download_track_id || '';
            let lastReportTime = 0;
            const onDownloadProgress = trackId ? (downloaded, total) => {
                const now = Date.now();
                if (now - lastReportTime < 300 && downloaded < total) return; // throttle to 300ms
                lastReportTime = now;
                const prev = downloadProgress.get(trackId) || {};
                const dt = (now - (prev._lastTime || now)) / 1000;
                const speed = dt > 0.2 ? (downloaded - (prev.downloaded || 0)) / dt : (prev.speed || 0);
                downloadProgress.set(trackId, {
                    downloaded, total,
                    percent: total > 0 ? Math.round((downloaded / total) * 100) : 0,
                    speed: Math.round(speed),
                    eta: speed > 0 ? Math.round((total - downloaded) / speed) : -1,
                    done: false,
                    _lastTime: now,
                });
            } : null;

            if (upload_type === 'remote' && remote_url) {
                try {
                    if (trackId) downloadProgress.set(trackId, { downloaded: 0, total: 0, percent: 0, speed: 0, eta: -1, done: false, _lastTime: Date.now() });
                    const result = await downloadRemoteFile(remote_url, 'video.mp4', onDownloadProgress);
                    if (trackId) { const p = downloadProgress.get(trackId); if (p) { p.percent = 100; p.done = true; } }
                    videoFilePath = result.filePath;
                    videoFileName = result.fileName;
                } catch (dlErr) {
                    if (trackId) downloadProgress.set(trackId, { percent: -1, done: true, error: dlErr.message });
                    return renderError(`Lỗi tải file remote: ${dlErr.message}`);
                }
            } else if (req.files && req.files.video && req.files.video[0]) {
                videoFilePath = req.files.video[0].path;
                videoFileName = req.files.video[0].filename;
            } else {
                return renderError('Vui lòng chọn file video hoặc nhập URL');
            }

            const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM videos').get();

            let qualities = req.body.qualities;
            console.log(`[Upload] Raw qualities from form: ${JSON.stringify(req.body.qualities)} (type: ${typeof req.body.qualities})`);
            if (!qualities) qualities = ['sd'];
            if (!Array.isArray(qualities)) qualities = [qualities];
            const validQualities = ['sd', 'hd'];
            qualities = qualities.filter(q => validQualities.includes(q));
            if (qualities.length === 0) qualities = ['sd'];
            const qualitiesJson = JSON.stringify(qualities);
            console.log(`[Upload] Final qualities: ${qualitiesJson}`);

            const result = db.prepare(`
        INSERT INTO videos (title, description, video_file, server_id, uploaded_by, status, qualities, visibility, sort_order)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(title.trim(), description || '', videoFileName, resolvedServerId, req.session.user.id, qualitiesJson, req.body.visibility || 'public', maxOrder.max_order + 1);

            const videoId = result.lastInsertRowid;
            // Pass sourceUrl for remote/gdrive so worker can download directly
            const sourceUrl = (upload_type === 'remote' && remote_url) ? remote_url : null;
            console.log(`[Upload] videoId=${videoId} qualities=${qualitiesJson} sourceUrl=${sourceUrl ? 'yes' : 'no'}`);
            const queuePos = encodeQueue.push({ videoId, videoFilePath, videoFileName, autoThumb: thumb_mode !== 'upload', qualities, sourceUrl });

            const queueMsg = queuePos === 0 && !encodeQueue.running
                ? 'Đang xử lý ngay...'
                : `Trong hàng đợi (vị trí ${encodeQueue.size})...`;
            return res.render('admin/upload', {
                title: 'Upload Video',
                servers,
                noServers,
                leastLoaded,
                error: null,
                success: `Video "${title}" đã được upload lên [${selectedServer.label}]! ${queueMsg}`
            });

        } catch (e) {
            console.error('[Upload Error]', e);
            const servers2 = db.prepare('SELECT * FROM servers WHERE is_active = 1 ORDER BY label').all();
            const leastLoaded2 = servers2.length > 0 ? pickLeastLoadedServer() : null;
            return res.render('admin/upload', { title: 'Upload Video', servers: servers2, noServers: servers2.length === 0, leastLoaded: leastLoaded2, error: `Lỗi server: ${e.message}`, success: null });
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
 * Process video: kiểm tra encode worker rảnh → gửi file/URL + serverConfig sang worker encode và SFTP.
 * Nếu không có worker → fallback encode local + SFTP từ app.
 */
async function processVideo(videoId, videoFilePath, videoFileName, autoThumb = true, qualities = ['sd'], sourceUrl = null) {
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

        // ── Thử dispatch sang encode worker trước ──
        try {
            const worker = await workerPool.findIdleWorker();
            if (worker) {
                let ok = false;

                // Ưu tiên dispatch URL (nhanh hơn, worker tự download)
                if (sourceUrl) {
                    console.log(`[Process] Dispatching URL to worker ${worker.label} for videoId=${videoId}...`);
                    ok = await workerPool.dispatchUrlToWorker(worker, {
                        videoId,
                        sourceUrl,
                        qualities,
                        autoThumb,
                    }, serverInfo);
                }

                // Fallback: dispatch file nếu URL dispatch thất bại hoặc không có sourceUrl
                if (!ok) {
                    console.log(`[Process] Dispatching file to worker ${worker.label} for videoId=${videoId}...`);
                    ok = await workerPool.dispatchFileToWorker(worker, {
                        videoId,
                        videoFilePath,
                        qualities,
                        autoThumb,
                    }, serverInfo);
                }

                if (ok) {
                    // Worker nhận rồi — nó sẽ encode + SFTP + callback về /api/worker/done
                    const { encodeQueue } = require('../services/queue');
                    encodeQueue.remoteJobs.set(videoId, { worker, job: { videoId }, dispatchedAt: new Date() });
                    console.log(`[Process] Video ${videoId} dispatched to worker ${worker.label}, waiting for callback...`);

                    // Timeout: nếu sau 45 phút không có callback → mark failed + re-add to queue
                    const WORKER_TIMEOUT_MS = 45 * 60 * 1000;
                    const timeoutHandle = setTimeout(async () => {
                        const { encodeQueue } = require('../services/queue');
                        if (!encodeQueue.remoteJobs.has(videoId)) return; // callback đã đến
                        encodeQueue.remoteJobs.delete(videoId);
                        const db2 = getDb();
                        const stillProcessing = db2.prepare("SELECT status FROM videos WHERE id=?").get(videoId);
                        if (stillProcessing && stillProcessing.status === 'processing') {
                            db2.prepare("UPDATE videos SET status='error', progress=0 WHERE id=?").run(videoId);
                            console.error(`[Timeout] Worker ${worker.label} không callback sau 45p cho videoId=${videoId} → marked error`);
                        }
                    }, WORKER_TIMEOUT_MS);
                    // Lưu timeout handle để cancel khi callback đến
                    encodeQueue.remoteJobs.get(videoId).timeoutHandle = timeoutHandle;

                    // Xóa file local nếu dùng URL dispatch (file đã download không cần giữ)
                    if (sourceUrl && videoFilePath && fs.existsSync(videoFilePath)) {
                        try {
                            fs.unlinkSync(videoFilePath);
                            console.log(`[Cleanup] Deleted local file (worker will download from URL): ${videoFilePath}`);
                        } catch (e) { /* ignore */ }
                    }
                    return;
                } else {
                    // Dispatch failed - giữ queued, worker poller sẽ re-dispatch
                    console.warn(`[Process] Worker dispatch thất bại cho videoId=${videoId}, chờ worker poller...`);
                    db.prepare("UPDATE videos SET status='queued', progress=0 WHERE id=?").run(videoId);
                    return;
                }
            } else {
                // No worker available - giữ queued, worker poller sẽ re-dispatch
                console.log(`[Process] Không có worker rảnh cho videoId=${videoId}, chờ worker poller...`);
                db.prepare("UPDATE videos SET status='queued', progress=0 WHERE id=?").run(videoId);
                return;
            }
        } catch (workerErr) {
            // Worker error - giữ queued, worker poller sẽ re-dispatch
            console.warn(`[Process] Lỗi khi tìm/dispatch worker cho videoId=${videoId}:`, workerErr.message, '— chờ worker poller...');
            db.prepare("UPDATE videos SET status='queued', progress=0 WHERE id=?").run(videoId);
            return;
        }

        // ── Local encode đã bị tắt — chỉ dùng remote worker ──
        // Nếu đến đây thì không có worker nào rảnh và re-queue đã được gọi
        return;
        if (!videoFilePath && sourceUrl) {
            console.log(`[Process] No local file for video ${videoId}, downloading from sourceUrl for local encode...`);
            const { downloadRemoteFile } = require('../services/upload');
            const dlResult = await downloadRemoteFile(sourceUrl, 'video.mp4');
            videoFilePath = dlResult.filePath;
            videoFileName = dlResult.fileName;
        }
        if (!videoFilePath) {
            throw new Error(`Video ${videoId}: Không có file để encode và không có sourceUrl.`);
        }

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

        // Upload qua SFTP (Hetzner, VPS...)
        db.prepare("UPDATE videos SET status = 'uploading', progress = 99 WHERE id = ?").run(videoId);
        sftpProgress.set(videoId, { done: 0, total: 0, file: '' });
        try {
            await uploadHlsToServer(serverInfo, localHlsDir, videoId.toString(), (done, total, file) => {
                sftpProgress.set(videoId, { done, total, file });
            });
            sftpProgress.delete(videoId);
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

        // Thumbnail (phải chạy trước cleanup vì cần file video gốc)
        let thumbnailName = '';
        if (autoThumb) {
            try { thumbnailName = `thumb_${videoId}.jpg`; await generateThumbnail(videoFilePath, THUMB_DIR, thumbnailName); }
            catch (e) { console.error('[Thumb] failed:', e.message); thumbnailName = ''; }
        }

        // Cleanup local files to free disk space on app server
        try {
            if (fs.existsSync(videoFilePath)) {
                fs.unlinkSync(videoFilePath);
                console.log(`[Cleanup] Deleted original video: ${videoFilePath}`);
            }
        } catch (e) { console.warn(`[Cleanup] Could not delete original video:`, e.message); }
        try {
            fs.rmSync(localHlsDir, { recursive: true, force: true });
            console.log(`[Cleanup] Deleted local HLS dir: ${localHlsDir}`);
        } catch (e) { console.warn(`[Cleanup] Could not delete HLS dir:`, e.message); }

        // Mark ready
    
    // Build full thumbnail URL — worker SFTP thumbnail lên storage server, không phải local
    let thumbnailUrl = video.thumbnail || '';
    if (thumbnailName) {
        const base = (serverInfo && serverInfo.cdn_url && serverInfo.cdn_url.trim())
            ? serverInfo.cdn_url.replace(/\/$/, '')
            : (serverInfo ? `http://${serverInfo.ip}` : '');
        thumbnailUrl = base ? `${base}/thumbnails/${thumbnailName}` : thumbnailName;
    }
    db.prepare(`UPDATE videos SET m3u8_url=?, iframe_url=?, thumbnail=?, status='ready', progress=100,
            updated_at=datetime('now','localtime') WHERE id=?`)
            .run(m3u8Url, iframeUrl, thumbnailName, videoId);

        console.log(`[Process] Video ${videoId} ready (local encode) → ${m3u8Url} [${qualities.join(', ')}]`);
    } catch (err) {
        console.error(`[Process] Video ${videoId} failed:`, err.message);
        if (!err._logged) {
            addErrorLog('unknown', {
                videoId, videoTitle: '',
                message: err.message, stack: err.stack
            });
        }
        db.prepare("UPDATE videos SET status='error', updated_at=datetime('now','localtime') WHERE id=?").run(videoId);
        // Cleanup: xoá file video gốc khi encode thất bại để tiết kiệm dung lượng
        try {
            if (fs.existsSync(videoFilePath)) {
                fs.unlinkSync(videoFilePath);
                console.log(`[Cleanup] Deleted failed video file: ${videoFilePath}`);
            }
        } catch (cleanupErr) {
            console.error(`[Cleanup] Failed to delete: ${cleanupErr.message}`);
        }
    }
}


// Wire the queue processor
encodeQueue.setProcessor(processVideo);


// ── Worker Poller (global, 1 timer duy nhất) ──────────────────────────────
// Thay vì setTimeout per-job, dùng 1 poller check workers định kỳ.
// Khi worker rảnh → lấy video 'queued' tiếp theo trong DB → dispatch.
(function startWorkerPoller() {
    const POLL_INTERVAL = 30 * 1000; // 30 giây
    setInterval(async () => {
        try {
            const { encodeQueue } = require('./services/queue');
            // Chỉ chạy nếu không có job nào đang dispatching
            if (encodeQueue.remoteJobs.size > 0) return;

            const worker = await workerPool.findIdleWorker();
            if (!worker) return; // Không có worker rảnh

            const db2 = getDb();
            // Lấy video queued cũ nhất chưa có trong encodeQueue
            const queuedIds = new Set([
                ...[...encodeQueue.queue].map(j => j.videoId),
                encodeQueue.currentId,
                ...[...encodeQueue.remoteJobs.keys()]
            ].filter(Boolean));

            const next = db2.prepare(`
                SELECT id, qualities, thumbnail, video_file
                FROM videos WHERE status = 'queued'
                ORDER BY sort_order ASC, id ASC LIMIT 20
            `).all().find(v => !queuedIds.has(v.id));

            if (!next) return; // Không có video queued nào đang chờ

            let qualities = ['sd'];
            try { qualities = JSON.parse(next.qualities || '["sd"]'); } catch (e) {}

            console.log(`[WorkerPoller] Found idle worker, dispatching videoId=${next.id}...`);
            encodeQueue.push({
                videoId: next.id,
                videoFilePath: null,
                videoFileName: null,
                autoThumb: !next.thumbnail,
                qualities,
                sourceUrl: next.video_file || null
            });
        } catch (e) {
            console.error('[WorkerPoller] Error:', e.message);
        }
    }, POLL_INTERVAL);
    console.log('[WorkerPoller] Started — poll interval:', POLL_INTERVAL / 1000, 's');
})();
// GET /admin/api/sftp-progress/:id — current SFTP file-upload progress
router.get('/api/sftp-progress/:id', requireAuth, (req, res) => {
    const videoId = parseInt(req.params.id);
    const prog = sftpProgress.get(videoId);
    if (prog) {
        return res.json({ uploading: true, done: prog.done, total: prog.total, file: prog.file });
    }
    return res.json({ uploading: false, done: 0, total: 0, file: '' });
});


// ── Process Monitor ────────────────────────────────────────────────────────────

// GET /admin/processes — Render process monitor page
router.get('/processes', requireAdmin, (req, res) => {
    res.render('admin/processes', { title: 'Theo dõi Tiến trình' });
});

// GET /admin/api/processes/snapshot — Live snapshot of all running processes
router.get('/api/processes/snapshot', requireAdmin, async (req, res) => {
    const db = getDb();
    const { encodeQueue } = require('../services/queue');
    const { getAllWorkersStatus } = require('../services/workerPool');

    // 1. Encode queue state
    const queueSnapshot = {
        running: encodeQueue.running,
        currentId: encodeQueue.current,
        pending: encodeQueue.snapshot(),
    };

    // 2. Current video being encoded — get title + progress from DB
    let currentVideo = null;
    if (encodeQueue.current) {
        currentVideo = db.prepare('SELECT id, title, progress, status FROM videos WHERE id = ?').get(encodeQueue.current);
    }

    // 3. SFTP transfers in progress
    const sftpList = [];
    for (const [videoId, prog] of sftpProgress.entries()) {
        const v = db.prepare('SELECT id, title FROM videos WHERE id = ?').get(videoId);
        sftpList.push({
            videoId,
            title: v ? v.title : `Video #${videoId}`,
            done: prog.done,
            total: prog.total,
            file: prog.file,
            pct: prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0,
        });
    }

    // 4. Remote worker jobs (dispatched, waiting callback)
    const remoteJobsList = [];
    for (const [videoId, info] of encodeQueue.remoteJobs.entries()) {
        const v = db.prepare('SELECT id, title FROM videos WHERE id = ?').get(videoId);
        remoteJobsList.push({
            videoId,
            title: v ? v.title : `Video #${videoId}`,
            worker: info.worker ? info.worker.label : '—',
            workerUrl: info.worker ? info.worker.url : '',
            dispatchedAt: info.dispatchedAt || null,
        });
    }

    // 5. Workers live status
    let workers = [];
    try {
        workers = await getAllWorkersStatus();
    } catch (_) {}

    // 6. Recent errors (last 10)
    const recentErrors = db.prepare(`
        SELECT id, type, video_id, video_title, server_label, message, created_at
        FROM error_logs ORDER BY created_at DESC LIMIT 10
    `).all();

    // 7. Videos currently in processing/uploading/queued
    const activeVideos = db.prepare(`
        SELECT id, title, status, progress, updated_at
        FROM videos
        WHERE status IN ('processing','uploading','queued')
        ORDER BY updated_at DESC
    `).all();

    res.json({
        ts: Date.now(),
        queue: queueSnapshot,
        currentVideo,
        sftpList,
        remoteJobs: remoteJobsList,
        workers,
        recentErrors,
        activeVideos,
    });
});


// GET /admin/videos - Video management list (all roles see all videos)
router.get('/videos', requireAuth, (req, res) => {
    const db = getDb();
    const pageSize = getPageSize();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * pageSize;

    // Count total
    const total = db.prepare('SELECT COUNT(*) as cnt FROM videos').get().cnt;

    const videos = db.prepare(`
      SELECT v.*, s.label as server_label, u.username as uploader_name
      FROM videos v
      LEFT JOIN servers s ON v.server_id = s.id
      LEFT JOIN users u ON v.uploaded_by = u.id
      ORDER BY v.sort_order DESC, v.created_at DESC
      LIMIT ? OFFSET ?
    `).all(pageSize, offset);

    const pendingVideoIds = db.prepare(
        `SELECT video_id FROM delete_requests WHERE status='pending'`
    ).all().map(r => r.video_id);

    res.render('admin/videos', {
        title: 'Quản lí Video', videos, pendingVideoIds,
        currentPage: page, totalPages: Math.ceil(total / pageSize),
        total, pageSize,
    });
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
router.post('/videos/:id/delete', requireAdmin, async (req, res) => {
    const db = getDb();
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);

    if (video) {
        // Purge CF cache trước khi xóa (fire & forget)
        if (video.server_id) {
            purgeVideoCache(video.id, video.server_id).catch(e =>
                console.error(`[CFCache] Purge failed for video ${video.id}:`, e.message)
            );
            // Xoá file HLS + thumbnail trên storage server
            const serverInfo = db.prepare('SELECT * FROM servers WHERE id = ?').get(video.server_id);
            deleteVideoFromStorage(serverInfo, video.id).catch(e =>
                console.error(`[SFTP Delete] Failed for video ${video.id}:`, e.message)
            );
        }

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

// POST /admin/videos/bulk-delete — Admin xoa nhieu video cung luc
router.post('/videos/bulk-delete', requireAdmin, async (req, res) => {
    const db = getDb();
    const { ids } = req.body;
    if (!ids || !ids.length) return res.json({ ok: false, error: 'Khong co video nao duoc chon' });

    const valid = ids.map(Number).filter(Boolean);
    let deleted = 0;

    for (const id of valid) {
        const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
        if (!video) continue;

        if (video.server_id) {
            purgeVideoCache(video.id, video.server_id).catch(() => {});
            const serverInfo = db.prepare('SELECT * FROM servers WHERE id = ?').get(video.server_id);
            if (serverInfo) {
                deleteVideoFromStorage(serverInfo, video.id).catch(e =>
                    console.error(`[BulkDelete] SFTP delete failed videoId=${id}:`, e.message)
                );
            }
        }

        const hlsDir = path.join(__dirname, '..', 'storage', 'hls', id.toString());
        if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });

        if (video.video_file) {
            const vp = path.join(UPLOAD_DIR, video.video_file);
            if (fs.existsSync(vp)) { try { fs.unlinkSync(vp); } catch (e) {} }
        }
        if (video.thumbnail && !video.thumbnail.startsWith('http')) {
            const tp = path.join(THUMB_DIR, video.thumbnail);
            if (fs.existsSync(tp)) { try { fs.unlinkSync(tp); } catch (e) {} }
        }

        db.prepare('DELETE FROM videos WHERE id = ?').run(id);
        deleted++;
    }

    console.log(`[BulkDelete] Deleted ${deleted}/${valid.length} videos`);
    res.json({ ok: true, deleted });
});
// POST /admin/api/videos/:id/purge-cache - Purge CF cache thủ công
router.post('/api/videos/:id/purge-cache', requireAdmin, async (req, res) => {
    const db = getDb();
    const video = db.prepare('SELECT id, server_id, title FROM videos WHERE id = ?').get(req.params.id);
    if (!video) return res.json({ ok: false, message: 'Video không tồn tại.' });
    try {
        const result = await purgeVideoCache(video.id, video.server_id);
        res.json({ ok: result.ok, purged: result.purged, errors: result.errors, message: result.ok ? `Đã purge ${result.purged} domain CF thành công.` : `Purge xong với ${result.errors.length} lỗi.` });
    } catch (e) {
        res.json({ ok: false, message: e.message });
    }
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

        // 3. Xoá file trên storage server (fire & forget)
        if (video.server_id) {
            const srvInfo = db.prepare('SELECT * FROM servers WHERE id = ?').get(video.server_id);
            deleteVideoFromStorage(srvInfo, video.id).catch(() => {});
        }

        // 4. Xóa database LUÔN để giao diện phản hồi nhanh
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

// POST /admin/api/videos/:id/cancel — JSON API (dùng bởi fetch() trong videos.ejs)
router.post('/api/videos/:id/cancel', requireAuth, (req, res) => {
    const db = getDb();
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);

    if (!video) return res.json({ ok: false, message: 'Video không tồn tại.' });

    // eslint-disable-next-line eqeqeq
    if (req.session.user.role !== 'administrator' && video.uploaded_by != req.session.user.id) {
        return res.status(403).json({ ok: false, message: 'Không có quyền hủy video này.' });
    }

    // 1. Cancel queue / remote worker
    const { encodeQueue } = require('../services/queue');
    encodeQueue.cancel(video.id);

    // 2. Kill local FFmpeg nếu có
    try {
        const { killFFmpeg } = require('../services/ffmpeg');
        killFFmpeg(video.id.toString());
        killFFmpeg(video.id);
    } catch (e) { /* ignore */ }

    // 3. Xoá file trên storage server (fire & forget)
    if (video.server_id) {
        const srvInfo = db.prepare('SELECT * FROM servers WHERE id = ?').get(video.server_id);
        deleteVideoFromStorage(srvInfo, video.id).catch(() => {});
    }

    // 4. Xóa DB
    db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);

    // 4. Xóa file tạm (setTimeout để FFmpeg nhả lock trên Windows)
    const hlsDir = path.join(__dirname, '..', 'storage', 'hls', video.id.toString());
    setTimeout(() => {
        try {
            if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });
            const UPLOAD_DIR2 = path.join(__dirname, '..', 'uploads', 'videos');
            const THUMB_DIR2 = path.join(__dirname, '..', 'uploads', 'thumbnails');
            if (video.video_file) { const vp = path.join(UPLOAD_DIR2, video.video_file); if (fs.existsSync(vp)) fs.unlinkSync(vp); }
            if (video.thumbnail) { const tp = path.join(THUMB_DIR2, video.thumbnail); if (fs.existsSync(tp)) fs.unlinkSync(tp); }
        } catch (err) {
            console.error(`[Cancel API] Cleanup error video ${video.id}:`, err.message);
        }
    }, 1500);

    console.log(`[Cancel API] Video ${video.id} cancelled by user ${req.session.user.id}`);
    res.json({ ok: true });
});

// POST /admin/api/videos/:id/retry — Re-queue a video in error state
router.post('/api/videos/:id/retry', requireAdmin, (req, res) => {
    const db = getDb();
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) return res.json({ ok: false, message: 'Video không tồn tại.' });
    if (!['error', 'uploading', 'queued'].includes(video.status)) {
        return res.json({ ok: false, message: `Không thể retry video ở trạng thái "${video.status}".` });
    }

    // Reset status and re-enqueue
    db.prepare("UPDATE videos SET status='queued', progress=0, updated_at=datetime('now','localtime') WHERE id=?").run(video.id);

    const qualities = (() => { try { return JSON.parse(video.qualities || '["sd"]'); } catch { return ['sd']; } })();
    const videoFilePath = path.join(UPLOAD_DIR, video.video_file || '');
    const { encodeQueue } = require('../services/queue');

    if (video.video_file && fs.existsSync(videoFilePath)) {
        // Re-enqueue locally
        encodeQueue.push({
            videoId: video.id,
            videoFilePath,
            videoFileName: video.video_file,
            autoThumb: !video.thumbnail,
            qualities,
        });
        console.log(`[Retry] Video ${video.id} re-queued locally`);
    } else if (video.remote_url || video.gdrive_url) {
        // Re-enqueue as remote download
        const src = video.remote_url ? 'remote' : 'gdrive';
        const srcUrl = video.remote_url || video.gdrive_url;
        encodeQueue.push({
            videoId: video.id,
            videoFilePath: srcUrl,
            videoFileName: srcUrl,
            autoThumb: !video.thumbnail,
            qualities,
            source: src,
        });
        console.log(`[Retry] Video ${video.id} re-queued from ${src}`);
    } else {
        return res.json({ ok: false, message: 'Không tìm thấy file gốc để retry.' });
    }

    res.json({ ok: true });
});

// POST /admin/api/videos/bulk-cancel — Cancel multiple processing videos
router.post('/api/videos/bulk-cancel', requireAdmin, (req, res) => {
    const { ids } = req.body; // array of video IDs
    if (!Array.isArray(ids) || ids.length === 0) return res.json({ ok: false, message: 'Thiếu danh sách ID.' });
    const { encodeQueue } = require('../services/queue');
    const { killFFmpeg } = require('../services/ffmpeg');
    const db = getDb();
    let cancelled = 0;
    for (const id of ids) {
        const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
        if (!video) continue;
        encodeQueue.cancel(video.id);
        try { killFFmpeg(video.id.toString()); killFFmpeg(video.id); } catch (_) {}
        // Xoá file trên storage server
        if (video.server_id) {
            const srvInfo = db.prepare('SELECT * FROM servers WHERE id = ?').get(video.server_id);
            deleteVideoFromStorage(srvInfo, video.id).catch(() => {});
        }
        db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
        const hlsDir = path.join(__dirname, '..', 'storage', 'hls', video.id.toString());
        setTimeout(() => {
            try { if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true }); } catch (_) {}
        }, 1500);
        cancelled++;
    }
    res.json({ ok: true, cancelled });
});

// POST /admin/api/videos/bulk-retry — Retry multiple errored videos
router.post('/api/videos/bulk-retry', requireAdmin, (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.json({ ok: false, message: 'Thiếu danh sách ID.' });
    const db = getDb();
    const { encodeQueue } = require('../services/queue');
    let retried = 0;
    for (const id of ids) {
        const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
        if (!video || !['error', 'uploading'].includes(video.status)) continue;
        db.prepare("UPDATE videos SET status='queued', progress=0, updated_at=datetime('now','localtime') WHERE id=?").run(video.id);
        const qualities = (() => { try { return JSON.parse(video.qualities || '["sd"]'); } catch { return ['sd']; } })();
        const videoFilePath = path.join(UPLOAD_DIR, video.video_file || '');
        if (video.video_file && fs.existsSync(videoFilePath)) {
            encodeQueue.push({ videoId: video.id, videoFilePath, videoFileName: video.video_file, autoThumb: !video.thumbnail, qualities });
            retried++;
        }
    }
    res.json({ ok: true, retried });
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
    const pageSize = getPageSize();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * pageSize;
    const total = db.prepare('SELECT COUNT(*) as cnt FROM delete_requests').get().cnt;
    const requests = db.prepare(`
        SELECT dr.*, v.title as video_title_live, v.thumbnail as video_thumb,
               u.username as requester_name,
               rv.username as reviewer_name
        FROM delete_requests dr
        LEFT JOIN videos v ON dr.video_id = v.id
        LEFT JOIN users u ON dr.requested_by = u.id
        LEFT JOIN users rv ON dr.reviewed_by = rv.id
        ORDER BY CASE dr.status WHEN 'pending' THEN 0 ELSE 1 END, dr.created_at DESC
        LIMIT ? OFFSET ?
    `).all(pageSize, offset);

    const pendingCount = db.prepare("SELECT COUNT(*) as cnt FROM delete_requests WHERE status='pending'").get().cnt;

    res.render('admin/delete-requests', {
        title: 'Yêu cầu Xoá Video',
        requests, pendingCount,
        msg: req.query.msg || null,
        currentPage: page, totalPages: Math.ceil(total / pageSize), total, pageSize,
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
        // Xoá file trên storage server
        if (video.server_id) {
            const srvInfo = db.prepare('SELECT * FROM servers WHERE id = ?').get(video.server_id);
            deleteVideoFromStorage(srvInfo, video.id).catch(() => {});
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
    const servers = getServerStats();
    res.render('admin/servers', { title: 'Quản lí Server', servers });
});

// GET /admin/api/servers/least-loaded - Trả về server ít video nhất
router.get('/api/servers/least-loaded', requireUploader, (req, res) => {
    const server = pickLeastLoadedServer();
    if (!server) return res.json({ ok: false, message: 'Không có server nào' });
    res.json({ ok: true, server: { id: server.id, label: server.label, ip: server.ip, video_count: server.video_count } });
});

// GET /admin/api/servers/:id/nginx-config - Generate Nginx config
router.get('/api/servers/:id/nginx-config', requireAdmin, (req, res) => {
    const db = getDb();
    const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).send('Server khong ton tai');

    const { getSetting } = require('../database');
    const bwLimit     = s.bandwidth_limit || '1m';
    const usePng      = s.use_png_camouflage !== 0;

    // Allowed embed domains setting
    const embedDomainRaw = getSetting('embed_allowed_domains', '');
    const embedDomains   = embedDomainRaw
        ? embedDomainRaw.split('\n').map(d => d.trim()).filter(Boolean)
        : [];
    const hasRestriction = embedDomains.length > 0;

    // Build map block for dynamic CORS origin (only when restriction active)
    let originMapBlock = '';
    if (hasRestriction) {
        const mapLines = embedDomains
            .map(d => `    "~*^https?://(www\\.)?${d.replace(/\./g, '\\.')}(:[0-9]+)?$" $http_origin;`)
            .join('\n');
        originMapBlock = `map $http_origin $cors_allow_origin {\n    default "";\n${mapLines}\n}\n\n`;
    }
    const corsOriginValue = hasRestriction ? '$cors_allow_origin' : '"*"';

    // Hotlink protection via CORS map (valid_referers removed - not needed with CORS)
    const validReferers = '';

    // CORS add_header block (always = send even on 4xx)
    const cors = `
        add_header Access-Control-Allow-Origin  ${corsOriginValue} always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Range, Origin, Accept" always;
        add_header Access-Control-Expose-Headers "Content-Range, Content-Length" always;`;

    // OPTIONS preflight
    const preflight = `
        if ($request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin  ${corsOriginValue};
            add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS";
            add_header Access-Control-Allow-Headers "Range, Origin, Accept";
            add_header Access-Control-Max-Age 86400;
            add_header Content-Length 0;
            return 204;
        }`;


    // Rate limiting zones (anti-leeching)
    const reqRate     = s.req_rate     || '10r/s'; // max 10 requests/s per IP
    const connLimit   = s.conn_limit   || 5;       // max 5 connections per IP
    const rateLimitZones = `# Rate limiting zones (paste this in nginx.conf http block if not already there)
# limit_req_zone  \$binary_remote_addr zone=hls_req:10m rate=${reqRate};
# limit_conn_zone \$binary_remote_addr zone=hls_conn:10m;
`;

    const rateLimitDirectives = `
        # Rate limiting - uncomment sau khi them zone vao nginx.conf http block:
        # limit_req  zone=hls_req burst=30 nodelay;
        # limit_conn zone=hls_conn ${connLimit};`;

    const segmentBlock = usePng ? `
    # TS segments served as .png (camouflage)
    location ~* ^/hls/([^/]+)/([^/]+)/(.+)\\.png$ {
${preflight}
        try_files /hls/$1/$2/$3.ts =404;
${rateLimitDirectives}
        types { }
        default_type image/png;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
${cors}
        access_log off;
        limit_rate_after 2m;
        limit_rate ${bwLimit};
    }` : `
    # TS segments served directly
    location ~* \\.ts$ {
${preflight}
        types { }
        default_type video/mp2t;
${rateLimitDirectives}
        add_header Cache-Control "public, max-age=31536000, immutable" always;
${cors}
        access_log off;
        limit_rate_after 2m;
        limit_rate ${bwLimit};
    }`;

    const m3u8SubFilter = usePng ? `
        sub_filter '.ts' '.png';
        sub_filter_once off;
        sub_filter_types application/vnd.apple.mpegurl text/plain;` : '';

    const m3u8Block = `
    # M3U8 playlists${usePng ? ' (sub .ts->.png)' : ''}
    location ~* \\.m3u8$ {
${preflight}
${validReferers}        types { }
        default_type application/vnd.apple.mpegurl;
${rateLimitDirectives}
${m3u8SubFilter}
        gzip on;
        gzip_types application/vnd.apple.mpegurl text/plain application/x-mpegURL;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
${cors}
    }`;


    const config = `${originMapBlock}${rateLimitZones}server {
    listen 80;
    server_name _;

    root ${s.storage_path || '/var/hls-storage'};
${segmentBlock}
${m3u8Block}

    # Health check
    location /ping {
        return 200 'ok';
        add_header Content-Type text/plain;
        access_log off;
    }

    # Thumbnails - serve anh preview cho video
    location /thumbnails/ {
${preflight}
        types { }
        default_type image/jpeg;
        add_header Cache-Control "public, max-age=86400" always;
${cors}
        access_log off;
    }

    location / { return 403; }
}
`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(config);
});
router.get('/servers/add', requireAdmin, (req, res) => {
    res.render('admin/server-form', { title: 'Thêm Server', server: null, error: null, success: null });
});

router.post('/servers/add', requireAdmin, async (req, res) => {
    const db = getDb();
    const { label, ip, port, username, password, storage_path, cdn_url, use_png_camouflage } = req.body;
    const pngCamouflage = [].concat(use_png_camouflage ?? []).includes('1') ? 1 : 0;

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
        INSERT INTO servers (label, server_type, ip, port, username, password, storage_path, cdn_url, use_png_camouflage)
        VALUES (?, 'sftp', ?, ?, ?, ?, ?, ?, ?)
    `).run(label, ip || '', parseInt(port) || 22, username || '', password || '',
        storage_path || '/var/hls-storage', cdn_url || '', pngCamouflage);

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
    const { label, ip, port, username, password, storage_path, cdn_url, use_png_camouflage } = req.body;
    const pngCamouflage = [].concat(use_png_camouflage ?? []).includes('1') ? 1 : 0;

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
            cdn_url=?, use_png_camouflage=?, updated_at=datetime('now','localtime')
        WHERE id=?
    `).run(label, ip || '', parseInt(port) || 22, username || '', finalPassword || '',
        storage_path || '/var/hls-storage', cdn_url || '', pngCamouflage, req.params.id);

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
    let disk = null;
    const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    try {
        const { testConnection, getDiskUsage } = require('../services/sftp');
        ok = await testConnection(server);
        message = ok ? `SFTP kết nối ${server.ip}:${server.port} thành công!` : `SFTP kết nối thất bại — server không phản hồi.`;
        // Lấy dung lượng ổ đĩa nếu kết nối thành công
        if (ok) {
            disk = await getDiskUsage(server);
            if (disk) {
                message += ` | Ổ đĩa: ${disk.used}/${disk.total} (${disk.percent})`;
            }
        }
    } catch (e) {
        ok = false;
        message = e.message;
    }

    const newStatus = ok ? 'live' : 'die';
    db.prepare(`UPDATE servers SET status=?, last_checked=? WHERE id=?`).run(newStatus, now, server.id);

    res.json({ ok, status: newStatus, message, last_checked: now, disk });
});



// =============================
// USER MANAGEMENT (admin only)
// =============================

router.get('/users', requireAdmin, (req, res) => {
    const db = getDb();
    const pageSize = getPageSize();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * pageSize;
    const total = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
    const users = db.prepare(
        'SELECT id, username, display_name, role, is_active, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(pageSize, offset);
    res.render('admin/users', {
        title: 'Quản lí Tài khoản', users, error: null, success: null,
        currentPage: page, totalPages: Math.ceil(total / pageSize), total, pageSize,
    });
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

    // Xoá file trên storage server (fire & forget)
    if (video.server_id) {
        const srvInfo = db.prepare('SELECT * FROM servers WHERE id = ?').get(video.server_id);
        deleteVideoFromStorage(srvInfo, video.id).catch(() => {});
    }

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

    // Read SA email for display
    let driveServiceEmail = null;
    try {
        const saRaw = getSetting('gdrive_service_account');
        if (saRaw) driveServiceEmail = JSON.parse(saRaw).client_email || null;
    } catch { /* ignore */ }

    res.render('admin/settings', {
        title: 'Cài đặt Hệ thống',
        apiToken: user ? user.api_token : null,
        currentPageSize: getPageSize(),
        driveServiceEmail,
        signedUrlSecret: getSetting('signed_url_secret', ''),
        signedUrlTtl: getSetting('signed_url_ttl', '4'),
        rateLimitLogin: getSetting('rate_limit_login', '10'),
        rateLimitApi: getSetting('rate_limit_api', '30'),
        embedAllowedDomains: getSetting('embed_allowed_domains', ''),
        success: req.query.saved ? 'Đã lưu cài đặt!' : null,
        error: null,
    });
});

// POST /admin/settings/gdrive-sa — Save Service Account JSON
router.post('/settings/gdrive-sa', requireAdmin, (req, res) => {
    const json = (req.body.service_account_json || '').trim();
    if (!json) return res.redirect('/admin/settings?saved=1');
    try {
        const parsed = JSON.parse(json);
        if (!parsed.client_email || !parsed.private_key) {
            return res.redirect('/admin/settings?error=sa_invalid');
        }
        setSetting('gdrive_service_account', JSON.stringify(parsed));
        console.log('[GDrive] Service Account saved:', parsed.client_email);
    } catch {
        return res.redirect('/admin/settings?error=sa_parse');
    }
    res.redirect('/admin/settings?saved=1');
});

// POST /admin/settings/signed-url — Save Signed URL settings
router.post('/settings/signed-url', requireAdmin, (req, res) => {
    const secret = (req.body.signed_url_secret || '').trim();
    const ttl = parseInt(req.body.signed_url_ttl, 10) || 4;
    setSetting('signed_url_secret', secret);
    setSetting('signed_url_ttl', String(ttl));
    console.log(`[Settings] Signed URL: secret=${secret ? '***' : '(empty)'}, ttl=${ttl}h`);
    res.redirect('/admin/settings?saved=1');
});


// POST /admin/settings/embed-domains -- Luu danh sach domain duoc phep embed
router.post('/settings/embed-domains', requireAdmin, (req, res) => {
    const raw = (req.body.embed_allowed_domains || '');
    const normalized = raw.split(/[\r\n,]+/)
        .map(d => d.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
        .filter(d => d.length > 0)
        .join('\n');
    setSetting('embed_allowed_domains', normalized);
    console.log('[Settings] embed_allowed_domains:', normalized || '(empty=public)');
    res.redirect('/admin/settings?saved=1');
});
// POST /admin/settings/gdrive-sa/remove — Remove Service Account
router.post('/settings/gdrive-sa/remove', requireAdmin, (req, res) => {
    setSetting('gdrive_service_account', '');
    res.redirect('/admin/settings?saved=1');
});

// GET /admin/api/gdrive/test — Test Service Account connection
router.get('/api/gdrive/test', requireAdmin, async (req, res) => {
    const { testServiceAccount } = require('../services/gdrive');
    const result = await testServiceAccount();
    res.json(result);
});

// POST /admin/settings/page-size — Save configurable page size
router.post('/settings/page-size', requireAdmin, (req, res) => {
    const n = parseInt(req.body.page_size);
    if (!isNaN(n) && n >= 5 && n <= 200) {
        setSetting('admin_page_size', String(n));
    }
    res.redirect('/admin/settings?saved=1');
});

// POST /admin/settings/rate-limit — Save rate limit settings
router.post('/settings/rate-limit', requireAdmin, (req, res) => {
    const loginLimit = parseInt(req.body.rate_limit_login) || 10;
    const apiLimit = parseInt(req.body.rate_limit_api) || 30;
    setSetting('rate_limit_login', String(Math.max(1, Math.min(1000, loginLimit))));
    setSetting('rate_limit_api', String(Math.max(1, Math.min(1000, apiLimit))));
    console.log(`[Settings] Rate limit: login=${loginLimit}/min, api=${apiLimit}/min`);
    res.redirect('/admin/settings?saved=1');
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

router.get('/guide', requireAuth, (req, res) => {
    const db = getDb();
    const servers = db.prepare('SELECT id, label, server_type FROM servers WHERE is_active=1').all();
    const user = db.prepare('SELECT api_token FROM users WHERE id = ?').get(req.session.user.id);
    res.render('admin/guide', {
        title: 'Hướng dẫn',
        servers,
        apiToken: user ? (user.api_token || '') : ''
    });
});

// =============================
// DATABASE MANAGEMENT
// =============================
router.get('/database', requireAdmin, (req, res) => {
    const db = getDb();
    const fs = require('fs');
    const dbPath = require('path').join(__dirname, '..', 'data', 'streaming.db');

    // DB info
    let dbSize = '—';
    try {
        const stats = fs.statSync(dbPath);
        const mb = (stats.size / 1024 / 1024).toFixed(2);
        dbSize = mb > 1 ? mb + ' MB' : (stats.size / 1024).toFixed(1) + ' KB';
    } catch (e) {}
    const walMode = db.pragma('journal_mode')[0].journal_mode;

    // Get all tables with row counts
    const rawTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const tables = rawTables.map(t => ({
        name: t.name,
        count: db.prepare(`SELECT COUNT(*) as cnt FROM "${t.name}"`).get().cnt
    }));

    const selectedTable = req.query.table || '';
    let tableData = [];
    let tableSchema = [];
    let tableIndexes = [];

    if (selectedTable && tables.some(t => t.name === selectedTable)) {
        tableData = db.prepare(`SELECT * FROM "${selectedTable}" ORDER BY rowid DESC LIMIT 200`).all();
        tableSchema = db.prepare(`PRAGMA table_info("${selectedTable}")`).all();
        tableIndexes = db.prepare(`PRAGMA index_list("${selectedTable}")`).all();
    }

    res.render('admin/database', {
        title: 'Database',
        dbInfo: { size: dbSize, tableCount: tables.length, walMode: walMode.toUpperCase() },
        tables,
        selectedTable,
        tableData,
        tableSchema,
        tableIndexes,
    });
});

// SQL Console API
router.post('/api/database/query', requireAdmin, (req, res) => {
    const db = getDb();
    const { sql } = req.body;
    if (!sql || !sql.trim()) return res.json({ error: 'Câu SQL trống' });

    const trimmed = sql.trim();
    const start = Date.now();

    try {
        // VACUUM / REINDEX can't use .prepare()
        if (/^\s*(VACUUM|REINDEX)/i.test(trimmed)) {
            db.exec(trimmed);
            res.json({ type: 'write', changes: 0, time: Date.now() - start });
            return;
        }
        // Detect if it's a SELECT/PRAGMA query
        const isSelect = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\s/i.test(trimmed);
        if (isSelect) {
            const rows = db.prepare(trimmed).all();
            res.json({ type: 'select', rows, time: Date.now() - start });
        } else {
            const result = db.prepare(trimmed).run();
            res.json({ type: 'write', changes: result.changes, time: Date.now() - start });
        }
    } catch (e) {
        res.json({ error: e.message });
    }
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
    console.log(`[Worker Callback] Progress received: videoId=${req.body.videoId} progress=${req.body.progress} token=${(req.headers['x-worker-token'] || '').substring(0, 8)}...`);
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
    console.log(`[Worker Callback] DONE received: videoId=${req.body.videoId} thumbnail=${req.body.thumbnailName} token=${(req.headers['x-worker-token'] || '').substring(0, 8)}...`);
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

    const iframeUrl = m3u8Url ? `/embed/${videoId}` : '';
    db.prepare(`UPDATE videos SET m3u8_url=?, iframe_url=?, thumbnail=?, status='ready', progress=100,
        updated_at=datetime('now','localtime') WHERE id=?`)
        .run(m3u8Url, iframeUrl, thumbnailUrl, videoId);

    const { encodeQueue } = require('../services/queue');
    // Cancel timeout handle nếu có (callback đến đúng hạn)
    const remoteJobInfo = encodeQueue.remoteJobs.get(videoId);
    if (remoteJobInfo && remoteJobInfo.timeoutHandle) {
        clearTimeout(remoteJobInfo.timeoutHandle);
    }
    encodeQueue.markRemoteDone(videoId);
    // Ngay lap tuc dispatch video queued tiep theo (khong cho poller 30s)
    setImmediate(async () => {
        try {
            const queuedIds = new Set([
                ...[...encodeQueue.queue].map(j => j.videoId),
                encodeQueue.currentId,
                ...[...encodeQueue.remoteJobs.keys()]
            ].filter(Boolean));
            const db2 = getDb();
            const rows = db2.prepare(SELECT id, qualities, thumbnail, video_file FROM videos WHERE status = 'queued' ORDER BY sort_order ASC, id ASC LIMIT 20).all();
            const next = rows.find(v => !queuedIds.has(v.id));
            if (next) {
                let q = ['sd'];
                try { q = JSON.parse(next.qualities || '["sd"]'); } catch (e) {}
                console.log([WorkerDone] Dispatching next queued videoId= + next.id);
                encodeQueue.push({ videoId: next.id, videoFilePath: null, videoFileName: null, autoThumb: !next.thumbnail, qualities: q, sourceUrl: next.video_file || null });
            }
        } catch (e) { console.error('[WorkerDone] Next dispatch error:', e.message); }
    });

    console.log(`[Worker Callback] Video ${videoId} DONE → ${m3u8Url}`);

    // Purge Cloudflare cache cho video vừa encode xong
    if (video.server_id) {
        const { purgeVideoCache } = require('../services/cfCache');
        purgeVideoCache(videoId, video.server_id)
            .then(r => console.log(`[CFCache] Purge videoId=${videoId}: purged=${r.purged}, errors=${r.errors.join(',') || 'none'}`))
            .catch(e => console.error('[CFCache] Purge error:', e.message));
    }
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
    const limit = getPageSize();
    const offset = (page - 1) * limit;
    const type = req.query.type || '';

    const where = type ? `WHERE type = '${type.replace(/'/g, '')}'` : '';
    const logs = db.prepare(`SELECT * FROM error_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM error_logs ${where}`).get().cnt;

    // Count by type for stats bar
    const typeRows = db.prepare('SELECT type, COUNT(*) as cnt FROM error_logs GROUP BY type').all();
    const typeCounts = {};
    typeRows.forEach(r => { typeCounts[r.type] = r.cnt; });

    res.render('admin/errors', {
        title: 'Nhật ký Lỗi',
        logs, total, page,
        totalPages: Math.ceil(total / limit),
        filterType: type,
        typeCounts,
        pageSize: limit,
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
    res.render('admin/cdn-accounts', {
        title: 'CDN Domains (CF Pool)',
        domains, servers,
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
router.post('/cdn/:id/edit', requireAdmin, (req, res) => {
    const db = getDb();
    const { label, cf_api_token, cf_zone_id, note, server_id } = req.body;
    db.prepare(`
        UPDATE cdn_domains
        SET label=COALESCE(NULLIF(?,''),(SELECT label FROM cdn_domains WHERE id=?)),
            cf_api_token=COALESCE(NULLIF(?,''),(SELECT cf_api_token FROM cdn_domains WHERE id=?)),
            cf_zone_id=COALESCE(NULLIF(?,''),(SELECT cf_zone_id FROM cdn_domains WHERE id=?)),
            note=?, server_id=?
        WHERE id=?
    `).run(label, req.params.id, cf_api_token, req.params.id, cf_zone_id, req.params.id,
        note || '', server_id || null, req.params.id);

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


// =============================
// ENCODE WORKERS (admin only)
// =============================

// GET /admin/workers — Trang quản lý encode workers
router.get('/workers', requireAdmin, async (req, res) => {
    const { getAllWorkersStatus } = require('../services/workerPool');
    const workers = await getAllWorkersStatus();
    res.render('admin/workers', { title: 'Encode Workers', workers, msg: req.query.msg || null });
});

// POST /admin/workers/add — Thêm worker mới
router.post('/workers/add', requireAdmin, (req, res) => {
    const { label, url, token } = req.body;
    if (!label || !url || !token) {
        return res.redirect('/admin/workers?msg=missing');
    }
    const { getWorkers, saveWorkers } = require('../services/workerPool');
    const workers = getWorkers();
    workers.push({ label: label.trim(), url: url.trim(), token: token.trim() });
    saveWorkers(workers);
    res.redirect('/admin/workers?msg=added');
});

// POST /admin/workers/:idx/delete — Xoá worker theo index
router.post('/workers/:idx/delete', requireAdmin, (req, res) => {
    const { getWorkers, saveWorkers } = require('../services/workerPool');
    const workers = getWorkers();
    const idx = parseInt(req.params.idx);
    if (!isNaN(idx) && idx >= 0 && idx < workers.length) {
        workers.splice(idx, 1);
        saveWorkers(workers);
    }
    res.redirect('/admin/workers?msg=deleted');
});


module.exports = router;
