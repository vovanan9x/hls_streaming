/**
 * HLS Encode Worker Server
 * Chạy độc lập trên server encode (Server 2, 3...)
 *
 * Setup:
 *   1. Copy thư mục /worker lên server encode
 *   2. npm install
 *   3. Tạo .env với WORKER_TOKEN và APP_URL
 *   4. npm start
 *
 * Yêu cầu:
 *   - ffmpeg cài sẵn (apt install ffmpeg)
 *   - multer: npm install multer
 *   - ssh2-sftp-client: npm install ssh2-sftp-client (đã có trong package.json)
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const multer = require('multer');
const SFTPClient = require('ssh2-sftp-client');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Increase request timeout for large file uploads (30 min)
app.use((req, res, next) => {
    req.setTimeout(1800000); // 30 min
    res.setTimeout(1800000);
    next();
});

const PORT = process.env.WORKER_PORT || 4000;
const WORKER_TOKEN = process.env.WORKER_TOKEN || 'change-this-secret-token';
const APP_URL = process.env.APP_URL || 'http://app-server:3000'; // URL của app server

// Storage Box mount point (chỉ dùng cho legacy /encode endpoint)
const STORAGE_BASE = process.env.HLS_OUTPUT_DIR || '/mnt/storagebox/hls';
const UPLOAD_BASE = process.env.UPLOAD_DIR || '/mnt/storagebox/uploads';

// Thư mục tạm để lưu file nhận từ app (upload-encode flow)
const TMP_DIR = process.env.WORKER_TMP_DIR || '/tmp/worker_uploads';
fs.mkdirSync(TMP_DIR, { recursive: true });

// Quality presets (giữ đồng bộ với app server)
// sd: giảm 30% độ phân giải so với gốc (tức 70% kích thước gốc)
// hd: giữ nguyên độ phân giải gốc 100%
const QUALITY_PRESETS = {
    'sd': { scaleFactor: 0.7, crf: 23, audioBitrate: '128k', bandwidth: 2176000, scaleDown: 'percent' },
    'hd': { crf: 18, audioBitrate: '192k', bandwidth: 8000000, scaleDown: false },
    // Legacy presets (backwards compat)
    '360p': { width: 640, height: 360, videoBitrate: '800k', audioBitrate: '96k', bandwidth: 896000, scaleDown: 'fixed' },
    '480p': { width: 854, height: 480, videoBitrate: '1400k', audioBitrate: '128k', bandwidth: 1536000, scaleDown: 'fixed' },
    '720p': { width: 1280, height: 720, videoBitrate: '2800k', audioBitrate: '128k', bandwidth: 2944000, scaleDown: 'fixed' },
    '1080p': { width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k', bandwidth: 5248000, scaleDown: 'fixed' },
};

// ====== State ======
let currentJob = null; // { videoId, pid, startedAt }
const runningCmds = new Map(); // videoId → ffmpeg command

// ====== Multer cho /upload-encode ======
const tmpStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.mp4';
        cb(null, `video_${Date.now()}${ext}`);
    }
});
const tmpUpload = multer({
    storage: tmpStorage,
    limits: { fileSize: Infinity }, // no file size limit
});

// ====== Middleware: Auth ======
function auth(req, res, next) {
    const token = req.headers['x-worker-token'];
    if (token !== WORKER_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ====== Routes ======

/** GET /status — App hỏi worker có rảnh không */
app.get('/status', auth, (req, res) => {
    res.json({
        busy: currentJob !== null,
        job: currentJob ? { videoId: currentJob.videoId, startedAt: currentJob.startedAt } : null,
        uptime: process.uptime(),
        storageOk: fs.existsSync(STORAGE_BASE),
        tmpDir: TMP_DIR,
    });
});

/**
 * POST /upload-encode — App gửi file video thực sự (multipart/form-data)
 * Fields:
 *   - video (file): file video
 *   - videoId (text): ID video trong DB
 *   - qualities (text): JSON array, e.g. '["sd"]'
 *   - autoThumb (text): "true"/"false"
 *   - callbackToken (text): token để báo callback
 *   - serverConfig (text): JSON object { ip, port, username, password, storage_path, cdn_url }
 */
app.post('/upload-encode', auth, async (req, res) => {
    // Dùng multer single() như middleware promise để tương thích multer 2.x
    try {
        await new Promise((resolve, reject) => {
            tmpUpload.single('video')(req, res, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    } catch (multerErr) {
        return res.status(400).json({ error: `Upload file lỗi: ${multerErr.message}` });
    }

    if (currentJob) {
        // Xóa file vừa upload vì worker bận
        if (req.file) {
            try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
        }
        return res.status(409).json({ error: 'Worker đang bận', currentVideoId: currentJob.videoId });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'Không có file video được gửi kèm' });
    }

    const { videoId, callbackToken } = req.body;
    if (!videoId) {
        try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
        return res.status(400).json({ error: 'Thiếu videoId' });
    }

    let qualities = ['sd'];
    try { qualities = JSON.parse(req.body.qualities || '["sd"]'); } catch (e) { /* default */ }

    const autoThumb = req.body.autoThumb === 'true' || req.body.autoThumb === true;

    let serverConfig = null;
    try { serverConfig = JSON.parse(req.body.serverConfig || 'null'); } catch (e) { /* null */ }

    const videoFilePath = req.file.path;
    const videoFileName = req.file.filename;

    console.log(`[Worker] Nhận file upload-encode: videoId=${videoId}, file=${videoFileName}, qualities=${qualities}`);

    // Trả về ngay để app không bị block
    res.json({ ok: true, message: 'File đã nhận, bắt đầu encode...' });

    // Chạy encode async
    processJob({
        videoId,
        videoFilePath,
        videoFileName,
        qualities,
        autoThumb,
        callbackToken,
        serverConfig,   // config để tự SFTP
        cleanupAfter: true, // xóa file tạm sau khi xong
    });
});

/** POST /download-encode — Worker tự download file từ URL rồi encode+SFTP (nhanh hơn upload-encode) */
app.post('/download-encode', auth, async (req, res) => {
    if (currentJob) {
        return res.status(409).json({ error: 'Worker đang bận', currentVideoId: currentJob.videoId });
    }

    const { videoId, sourceUrl, qualities: rawQ, autoThumb: rawThumb, callbackToken, serverConfig: rawServer } = req.body;

    if (!videoId || !sourceUrl) {
        return res.status(400).json({ error: 'Thiếu videoId hoặc sourceUrl' });
    }

    let qualities, autoThumb, serverConfig;
    try {
        qualities = typeof rawQ === 'string' ? JSON.parse(rawQ) : (rawQ || ['sd']);
        autoThumb = rawThumb === true || rawThumb === 'true';
        serverConfig = typeof rawServer === 'string' ? JSON.parse(rawServer) : rawServer;
    } catch (parseErr) {
        return res.status(400).json({ error: 'Parse lỗi: ' + parseErr.message });
    }

    // Trả về ngay để app không bị block
    res.json({ ok: true, message: 'Worker bắt đầu download & encode...' });

    // Download file từ URL
    const ext = path.extname(sourceUrl.split('?')[0]) || '.mp4';
    const videoFileName = `video_${videoId}_${Date.now()}${ext}`;
    const videoFilePath = path.join(TMP_DIR, videoFileName);

    try {
        console.log(`[Worker] Download-encode videoId=${videoId} from URL: ${sourceUrl.substring(0, 100)}...`);

        const axios2 = require('axios');
        const response = await axios2({
            method: 'GET',
            url: sourceUrl,
            responseType: 'stream',
            timeout: 1800000, // 30 min
        });

        const totalSize = parseInt(response.headers['content-length'] || '0');
        let downloaded = 0;
        let lastLogPct = 0;

        response.data.on('data', (chunk) => {
            downloaded += chunk.length;
            if (totalSize > 0) {
                const pct = Math.round((downloaded / totalSize) * 100);
                if (pct >= lastLogPct + 10) {
                    lastLogPct = pct;
                    console.log(`[Worker] Download progress: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(totalSize / 1024 / 1024).toFixed(1)}MB)`);
                }
            }
        });

        const writer = fs.createWriteStream(videoFilePath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const sizeMB = (fs.statSync(videoFilePath).size / 1024 / 1024).toFixed(1);
        console.log(`[Worker] Download complete: ${sizeMB}MB → ${videoFileName}`);

        // Chạy encode async
        processJob({
            videoId,
            videoFilePath,
            videoFileName,
            qualities,
            autoThumb,
            callbackToken,
            serverConfig,
            cleanupAfter: true,
        });
    } catch (dlErr) {
        console.error(`[Worker] Download failed for videoId=${videoId}:`, dlErr.message);
        await reportDone(videoId, false, null, '', `Download failed: ${dlErr.message}`, callbackToken);
        try { if (fs.existsSync(videoFilePath)) fs.unlinkSync(videoFilePath); } catch (e) { /* ignore */ }
    }
});


/** POST /encode — Legacy: App gửi job encode (dùng shared storage) */
app.post('/encode', auth, async (req, res) => {
    if (currentJob) {
        return res.status(409).json({ error: 'Worker đang bận', currentVideoId: currentJob.videoId });
    }

    const { videoId, videoFileName, qualities, autoThumb, callbackToken } = req.body;

    if (!videoId || !videoFileName) {
        return res.status(400).json({ error: 'Thiếu videoId hoặc videoFileName' });
    }

    const videoFilePath = path.join(UPLOAD_BASE, videoFileName);
    if (!fs.existsSync(videoFilePath)) {
        return res.status(404).json({ error: `File không tồn tại: ${videoFilePath}` });
    }

    // Trả về ngay để app không bị block
    res.json({ ok: true, message: 'Job đã nhận, bắt đầu encode...' });

    // Chạy encode async (legacy: không tự SFTP)
    processJob({ videoId, videoFilePath, videoFileName, qualities: qualities || ['sd'], autoThumb, callbackToken });
});

/** POST /cancel — App yêu cầu dừng encode */
app.post('/cancel', auth, (req, res) => {
    const { videoId } = req.body;
    const cmd = runningCmds.get(videoId);
    if (cmd) {
        try { cmd.kill('SIGKILL'); } catch (e) { }
        runningCmds.delete(videoId);
    }
    if (currentJob && currentJob.videoId == videoId) {
        currentJob = null;
    }
    res.json({ ok: true });
});

// ====== Encode Logic ======

function timemarkToSeconds(tm) {
    if (!tm) return 0;
    const p = tm.split(':');
    return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
}

function getVideoDuration(inputPath) {
    return new Promise(resolve => {
        ffmpeg.ffprobe(inputPath, (err, meta) => {
            resolve(err ? 0 : parseFloat((meta && meta.format && meta.format.duration) || 0));
        });
    });
}

function encodeQuality(inputPath, outputDir, preset, qualityName, totalDur, onProgress, videoId) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(outputDir, { recursive: true });
        const m3u8 = path.join(outputDir, 'index.m3u8');
        let lastPct = -1;

        const outputOpts = [];
        if (preset.scaleDown === 'fixed') {
            outputOpts.push(`-vf scale=${preset.width}:${preset.height}:force_original_aspect_ratio=decrease,pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2`);
        } else if (preset.scaleDown === 'percent' && preset.scaleFactor) {
            const f = preset.scaleFactor;
            outputOpts.push(`-vf scale=trunc(iw*${f}/2)*2:trunc(ih*${f}/2)*2`);
        }
        // HD: không thêm filter scale
        // CRF mode: chất lượng đều, file nhỏ hơn ABR cố định
        if (preset.crf !== undefined) {
            outputOpts.push(`-crf ${preset.crf}`);
        } else if (preset.videoBitrate) {
            outputOpts.push(`-b:v ${preset.videoBitrate}`);
        }
        outputOpts.push(
            `-b:a ${preset.audioBitrate}`,
            '-codec:v libx264',
            '-codec:a aac',
            '-preset fast',
            '-profile:v high',
            '-level 4.1',
            '-pix_fmt yuv420p',
            '-g 48',
            '-keyint_min 48',
            '-sc_threshold 0',
            '-ac 2',
            '-start_number 0',
            '-hls_time 6',
            '-hls_list_size 0',
            `-hls_segment_filename ${path.join(outputDir, 'seg_%03d.ts')}`,
            '-f hls',
        );

        const cmd = ffmpeg(inputPath)
            .outputOptions(outputOpts)
            .output(m3u8)
            .on('start', () => console.log(`[Worker] Encoding ${qualityName} for video ${videoId}...`))
            .on('progress', progress => {
                let pct = 0;
                if (totalDur > 0 && progress.timemark) {
                    pct = Math.min(99, Math.round((timemarkToSeconds(progress.timemark) / totalDur) * 100));
                } else if (progress.percent > 0) {
                    pct = Math.min(99, Math.round(progress.percent));
                }
                if (pct > lastPct) { lastPct = pct; if (onProgress) onProgress(pct); }
            })
            .on('end', () => { runningCmds.delete(videoId); resolve(m3u8); })
            .on('error', err => { runningCmds.delete(videoId); reject(err); });

        runningCmds.set(videoId, cmd);
        cmd.run();
    });
}

function writeMasterPlaylist(outputDir, qualities) {
    let content = '#EXTM3U\n#EXT-X-VERSION:3\n';
    for (const q of qualities) {
        const p = QUALITY_PRESETS[q];
        if (!p) continue;
        if (p.scaleDown !== false && p.width && p.height) {
            content += `#EXT-X-STREAM-INF:BANDWIDTH=${p.bandwidth},RESOLUTION=${p.width}x${p.height},NAME="${q}"\n${q}/index.m3u8\n`;
        } else {
            content += `#EXT-X-STREAM-INF:BANDWIDTH=${p.bandwidth},NAME="${q}"\n${q}/index.m3u8\n`;
        }
    }
    fs.writeFileSync(path.join(outputDir, 'master.m3u8'), content, 'utf8');
}

/** Báo progress về App server */
async function reportProgress(videoId, progress, callbackToken) {
    const url = `${APP_URL}/api/worker/progress`;
    const token = callbackToken || WORKER_TOKEN;
    try {
        await axios.post(url, { videoId, progress }, {
            headers: { 'x-worker-token': token },
            timeout: 5000,
            maxRedirects: 0,
        });
    } catch (e) {
        const status = e.response ? e.response.status : 'no response';
        const body = e.response ? JSON.stringify(e.response.data) : '';
        console.error(`[Worker] Không thể báo progress: ${e.message} | URL=${url} | status=${status} | body=${body}`);
    }
}

/** Báo kết quả cuối về App server (có retry 3 lần) */
async function reportDone(videoId, ok, m3u8Url, thumbnailName, error, callbackToken) {
    const endpoint = ok ? 'done' : 'error';
    const url = `${APP_URL}/api/worker/${endpoint}`;
    const token = callbackToken || WORKER_TOKEN;
    const data = { videoId, m3u8Url, thumbnailName, error };

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const resp = await axios.post(url, data, {
                headers: { 'x-worker-token': token },
                timeout: 10000,
                maxRedirects: 0,
            });
            console.log(`[Worker] reportDone(${endpoint}) success for videoId=${videoId} (attempt ${attempt}), response:`, resp.data);
            return; // thành công → exit
        } catch (e) {
            const status = e.response ? e.response.status : 'no response';
            const body = e.response ? JSON.stringify(e.response.data) : '';
            console.error(`[Worker] reportDone(${endpoint}) FAILED attempt ${attempt}/3: ${e.message} | URL=${url} | token=${token ? token.substring(0, 8) + '...' : 'EMPTY'} | status=${status} | body=${body}`);
            if (attempt < 3) {
                await new Promise(r => setTimeout(r, 2000)); // chờ 2s rồi thử lại
            }
        }
    }
    console.error(`[Worker] reportDone(${endpoint}) ALL 3 ATTEMPTS FAILED for videoId=${videoId}! App DB sẽ không cập nhật.`);
}

/**
 * Upload toàn bộ thư mục HLS lên SFTP server
 * @param {object} serverConfig - { ip, port, username, password, storage_path }
 * @param {string} localHlsDir - Thư mục HLS local (vd: /tmp/hls/123)
 * @param {string} videoId - ID video (dùng làm tên thư mục trên server)
 */
async function sftpUploadHls(serverConfig, localHlsDir, videoId) {
    const sftp = new SFTPClient();
    const remotePath = `${(serverConfig.storage_path || '/var/hls-storage').replace(/\/$/, '')}/hls/${videoId}`;

    try {
        await sftp.connect({
            host: serverConfig.ip,
            port: parseInt(serverConfig.port) || 22,
            username: serverConfig.username,
            password: serverConfig.password,
            readyTimeout: 30000,
        });

        console.log(`[Worker] SFTP connected to ${serverConfig.ip}, uploading hls/${videoId}...`);

        // Đảm bảo thư mục đích tồn tại
        await sftp.mkdir(remotePath, true).catch(() => { /* đã tồn tại */ });

        // Upload tất cả file trong thư mục HLS
        const files = getAllFilesRecursive(localHlsDir);

        // Pre-create all remote directories
        const allDirs = new Set(files.map(f => {
            const relPath = path.relative(localHlsDir, f).replace(/\\/g, '/');
            return path.dirname(`${remotePath}/${relPath}`).replace(/\\/g, '/');
        }));
        for (const dir of allDirs) {
            await sftp.mkdir(dir, true).catch(() => { /* đã tồn tại */ });
        }

        // Parallel upload with concurrency limit
        const CONCURRENCY = 8;
        let idx = 0;
        const total = files.length;

        async function worker() {
            while (idx < total) {
                const localFile = files[idx++];
                const relPath = path.relative(localHlsDir, localFile).replace(/\\/g, '/');
                const remoteFile = `${remotePath}/${relPath}`;
                await sftp.put(localFile, remoteFile);
            }
        }

        await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, total) }, worker)
        );

        console.log(`[Worker] SFTP upload done: ${remotePath} (${files.length} files, ${CONCURRENCY} parallel)`);
    } finally {
        await sftp.end().catch(() => { /* ignore */ });
    }
}

/** Lấy tất cả file trong thư mục (đệ quy) */
function getAllFilesRecursive(dir) {
    const results = [];
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const full = path.join(dir, item);
        if (fs.statSync(full).isDirectory()) {
            results.push(...getAllFilesRecursive(full));
        } else {
            results.push(full);
        }
    }
    return results;
}

async function processJob({ videoId, videoFilePath, videoFileName, qualities, autoThumb, callbackToken, serverConfig, cleanupAfter }) {
    currentJob = { videoId, startedAt: new Date().toISOString() };
    console.log(`[Worker] START job videoId=${videoId} qualities=${qualities} sftp=${serverConfig ? serverConfig.ip : 'none (legacy)'}`);

    // Nếu có serverConfig → encode vào thư mục tạm local, sau đó SFTP
    // Nếu không có serverConfig → encode thẳng vào shared storage (legacy)
    const useTmpHls = !!serverConfig;
    const hlsDir = useTmpHls
        ? path.join(TMP_DIR, `hls_${videoId}`)
        : path.join(STORAGE_BASE, videoId.toString());

    let thumbnailName = '';

    try {
        const totalDur = await getVideoDuration(videoFilePath);
        const total = qualities.length;

        // Encode tất cả qualities song song (Promise.all) — nhanh hơn sequential ~40-60%
        const encodeProgress = new Array(qualities.length).fill(0);
        await Promise.all(qualities.map(async (q, i) => {
            const preset = QUALITY_PRESETS[q];
            if (!preset) { console.warn(`[Worker] Unknown quality: ${q}`); return; }
            const qDir = path.join(hlsDir, q);
            await encodeQuality(videoFilePath, qDir, preset, q, totalDur, async (pct) => {
                encodeProgress[i] = pct;
                const avg = Math.round(encodeProgress.reduce((a, b) => a + b, 0) / encodeProgress.length);
                await reportProgress(videoId, Math.min(99, avg), callbackToken);
            }, videoId);
        }));

        writeMasterPlaylist(hlsDir, qualities);

        // Thumbnail
        if (autoThumb) {
            try {
                const thumbName = `thumb_${videoId}.jpg`;
                const thumbDir = useTmpHls ? path.join(TMP_DIR, 'thumbnails') : path.join(UPLOAD_BASE, '..', 'thumbnails');
                fs.mkdirSync(thumbDir, { recursive: true });
                await new Promise((resolve, reject) => {
                    ffmpeg(videoFilePath)
                        .screenshots({ count: 1, folder: thumbDir, filename: thumbName, size: '640x360', timemarks: ['10%'] })
                        .on('end', resolve).on('error', reject);
                });
                thumbnailName = thumbName;
            } catch (e) {
                console.error('[Worker] Thumbnail failed:', e.message);
            }
        }

        // ── SFTP Upload (chỉ khi có serverConfig) ──
        if (serverConfig) {
            console.log(`[Worker] Bắt đầu SFTP upload lên ${serverConfig.ip}...`);
            await sftpUploadHls(serverConfig, hlsDir, videoId);

            // Upload thumbnail nếu có
            if (thumbnailName && autoThumb) {
                const localThumb = path.join(TMP_DIR, 'thumbnails', thumbnailName);
                if (fs.existsSync(localThumb)) {
                    const sftp2 = new SFTPClient();
                    try {
                        await sftp2.connect({
                            host: serverConfig.ip,
                            port: parseInt(serverConfig.port) || 22,
                            username: serverConfig.username,
                            password: serverConfig.password,
                            readyTimeout: 30000,
                        });
                        const remoteThumbDir = `${(serverConfig.storage_path || '/var/hls-storage').replace(/\/$/, '')}/thumbnails`;
                        await sftp2.mkdir(remoteThumbDir, true).catch(() => { /* ok */ });
                        await sftp2.put(localThumb, `${remoteThumbDir}/${thumbnailName}`);
                        // chmod 644 để nginx (www-data/nginx user) có thể đọc file
                        await sftp2.chmod(`${remoteThumbDir}/${thumbnailName}`, 0o644).catch(() => {});
                        // Đảm bảo thư mục thumbnails cũng có quyền đọc
                        await sftp2.chmod(remoteThumbDir, 0o755).catch(() => {});
                        console.log(`[Worker] Thumbnail SFTP uploaded: ${thumbnailName}`);
                    } finally {
                        await sftp2.end().catch(() => { /* ignore */ });
                    }
                }
            }
        }

        // Báo done về App — App tự build m3u8_url từ serverInfo config
        await reportDone(videoId, true, null, thumbnailName, null, callbackToken);
        console.log(`[Worker] DONE videoId=${videoId}`);

    } catch (err) {
        console.error(`[Worker] FAILED videoId=${videoId}:`, err.message);
        await reportDone(videoId, false, null, '', err.message, callbackToken);
    } finally {
        currentJob = null;

        // Dọn file tạm
        if (cleanupAfter) {
            setTimeout(() => {
                try { if (fs.existsSync(videoFilePath)) fs.unlinkSync(videoFilePath); } catch (e) { /* ignore */ }
                try { if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
                console.log(`[Worker] Cleaned up tmp files for videoId=${videoId}`);
            }, 2000);
        }
    }
}

// ====== Start ======
const server = app.listen(PORT, () => {
    console.log(`🔧 HLS Encode Worker đang chạy: http://0.0.0.0:${PORT}`);
    console.log(`   Tmp Dir: ${TMP_DIR}`);
    console.log(`   App URL: ${APP_URL}`);
    console.log(`   Legacy Storage: ${STORAGE_BASE}`);
});

// Keep-alive timeout: prevent connection drops during large file uploads
server.keepAliveTimeout = 1800000; // 30 min
server.headersTimeout = 1830000;   // slightly more than keepAliveTimeout
