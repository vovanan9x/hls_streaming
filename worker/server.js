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
 *   - Storage Box mount tại /mnt/storagebox (sshfs)
 *   - Cùng mount point với app server
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.WORKER_PORT || 4000;
const WORKER_TOKEN = process.env.WORKER_TOKEN || 'change-this-secret-token';
const APP_URL = process.env.APP_URL || 'http://app-server:3000'; // URL của app server

// Storage Box mount point (phải giống app server)
const STORAGE_BASE = process.env.HLS_OUTPUT_DIR || '/mnt/storagebox/hls';
const UPLOAD_BASE = process.env.UPLOAD_DIR || '/mnt/storagebox/uploads';

// Quality presets (giữ đồng bộ với app server)
// sd: encode xuống tối đa 720p (không upscale nếu gốc nhỏ hơn)
// hd: giữ nguyên độ phân giải gốc 100%
const QUALITY_PRESETS = {
    'sd': { maxHeight: 720, videoBitrate: '2000k', audioBitrate: '128k', bandwidth: 2176000, scaleDown: true },
    'hd': { videoBitrate: '0', audioBitrate: '192k', bandwidth: 8000000, scaleDown: false },
    // Legacy presets (backwards compat)
    '360p': { width: 640, height: 360, videoBitrate: '800k', audioBitrate: '96k', bandwidth: 896000, scaleDown: 'fixed' },
    '480p': { width: 854, height: 480, videoBitrate: '1400k', audioBitrate: '128k', bandwidth: 1536000, scaleDown: 'fixed' },
    '720p': { width: 1280, height: 720, videoBitrate: '2800k', audioBitrate: '128k', bandwidth: 2944000, scaleDown: 'fixed' },
    '1080p': { width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k', bandwidth: 5248000, scaleDown: 'fixed' },
};

// ====== State ======
let currentJob = null; // { videoId, pid, startedAt }
const runningCmds = new Map(); // videoId → ffmpeg command

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
    });
});

/** POST /encode — App gửi job encode mới */
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

    // Chạy encode async
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
        } else if (preset.scaleDown === true && preset.maxHeight) {
            // SD: giới hạn chiều cao tối đa, không upscale, không pad
            outputOpts.push(`-vf scale=-2:min(ih\,${preset.maxHeight})`);
        }
        // HD: không thêm filter scale
        if (preset.videoBitrate === '0') {
            outputOpts.push('-crf 18');
        } else {
            outputOpts.push(`-b:v ${preset.videoBitrate}`);
        }
        outputOpts.push(
            `-b:a ${preset.audioBitrate}`,
            '-codec:v libx264',
            '-codec:a aac',
            '-preset fast',
            '-profile:v baseline',
            '-level 3.0',
            '-start_number 0',
            '-hls_time 6',
            '-hls_list_size 0',
            `-hls_segment_filename ${path.join(outputDir, 'seg_%03d.ts')}`,
            '-f hls',
        );

        const cmd = ffmpeg(inputPath)
            .outputOptions(outputOpts)
            .output(m3u8)
            .on('start', () => console.log(`[Worker] Encoding ${qualityName} for ${videoId}...`))
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
    try {
        await axios.post(`${APP_URL}/admin/api/worker/progress`, { videoId, progress }, {
            headers: { 'x-worker-token': callbackToken || WORKER_TOKEN },
            timeout: 5000,
        });
    } catch (e) {
        console.error('[Worker] Không thể báo progress:', e.message);
    }
}

/** Báo kết quả cuối về App server */
async function reportDone(videoId, ok, m3u8Url, thumbnailName, error, callbackToken) {
    try {
        await axios.post(`${APP_URL}/admin/api/worker/${ok ? 'done' : 'error'}`, {
            videoId, m3u8Url, thumbnailName, error
        }, {
            headers: { 'x-worker-token': callbackToken || WORKER_TOKEN },
            timeout: 10000,
        });
    } catch (e) {
        console.error('[Worker] Không thể báo done/error:', e.message);
    }
}

async function processJob({ videoId, videoFilePath, videoFileName, qualities, autoThumb, callbackToken }) {
    currentJob = { videoId, startedAt: new Date().toISOString() };
    console.log(`[Worker] START job videoId=${videoId} qualities=${qualities}`);

    const hlsDir = path.join(STORAGE_BASE, videoId.toString());
    let m3u8Url = null;
    let thumbnailName = '';

    try {
        const totalDur = await getVideoDuration(videoFilePath);
        const total = qualities.length;

        for (let i = 0; i < total; i++) {
            const q = qualities[i];
            const preset = QUALITY_PRESETS[q];
            if (!preset) { console.warn(`[Worker] Unknown quality: ${q}`); continue; }

            const qDir = path.join(hlsDir, q);
            await encodeQuality(videoFilePath, qDir, preset, q, totalDur, async (pct) => {
                const overall = Math.round((i / total) * 100 + (pct / total));
                await reportProgress(videoId, Math.min(99, overall), callbackToken);
            }, videoId);
        }

        writeMasterPlaylist(hlsDir, qualities);

        // m3u8Url sẽ được app server tự build từ server config (CDN URL hoặc IP)
        // Worker chỉ cần báo "done" để app biết update DB
        m3u8Url = null; // App tự tính

        // Thumbnail
        if (autoThumb) {
            try {
                const thumbName = `thumb_${videoId}.jpg`;
                const thumbDir = path.join(UPLOAD_BASE, '..', 'thumbnails');
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

        await reportDone(videoId, true, null, thumbnailName, null, callbackToken);
        console.log(`[Worker] DONE videoId=${videoId}`);
    } catch (err) {
        console.error(`[Worker] FAILED videoId=${videoId}:`, err.message);
        await reportDone(videoId, false, null, '', err.message, callbackToken);
    } finally {
        currentJob = null;
    }
}

// ====== Start ======
app.listen(PORT, () => {
    console.log(`🔧 HLS Encode Worker đang chạy: http://0.0.0.0:${PORT}`);
    console.log(`   Storage: ${STORAGE_BASE}`);
    console.log(`   App URL: ${APP_URL}`);
    if (!fs.existsSync(STORAGE_BASE)) {
        console.warn(`⚠️  Storage path chưa mount: ${STORAGE_BASE}`);
    }
});
