const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const path = require('path');
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Quality presets
// sd: giảm 30% độ phân giải so với gốc (tức 70% kích thước gốc)
// hd: giữ nguyên độ phân giải gốc 100%
const QUALITY_PRESETS = {
    'sd': { scaleFactor: 0.7, videoBitrate: '2000k', audioBitrate: '128k', bandwidth: 2176000, scaleDown: 'percent' },
    'hd': { videoBitrate: '0', audioBitrate: '192k', bandwidth: 8000000, scaleDown: false },
    // Legacy presets (backwards compat)
    '360p': { width: 640, height: 360, videoBitrate: '800k', audioBitrate: '96k', bandwidth: 896000, scaleDown: 'fixed' },
    '480p': { width: 854, height: 480, videoBitrate: '1400k', audioBitrate: '128k', bandwidth: 1536000, scaleDown: 'fixed' },
    '720p': { width: 1280, height: 720, videoBitrate: '2800k', audioBitrate: '128k', bandwidth: 2944000, scaleDown: 'fixed' },
    '1080p': { width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k', bandwidth: 5248000, scaleDown: 'fixed' },
};

/**
 * Parse timemark "HH:MM:SS.ms" to seconds
 */
function timemarkToSeconds(timemark) {
    if (!timemark) return 0;
    const parts = timemark.split(':');
    if (parts.length !== 3) return 0;
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
}

/**
 * Get video duration in seconds via ffprobe
 */
function getVideoDuration(inputPath) {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) return resolve(0);
            resolve(parseFloat((metadata && metadata.format && metadata.format.duration) || 0));
        });
    });
}

// Lưu các ffmpeg command đang chạy theo videoId
const runningCommands = new Map();

/**
 * Encode a single quality stream to HLS
 */
function encodeQuality(inputPath, outputDir, preset, qualityName, totalDuration, onProgress, videoId) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(outputDir, { recursive: true });
        const m3u8 = path.join(outputDir, 'index.m3u8');
        let lastReported = -1;

        // Build output options dựa vào loại preset
        const outputOpts = [];
        if (preset.scaleDown === 'fixed') {
            // Legacy 360p/480p/720p/1080p: scale cố định + pad
            outputOpts.push(`-vf scale=${preset.width}:${preset.height}:force_original_aspect_ratio=decrease,pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2`);
        } else if (preset.scaleDown === 'percent' && preset.scaleFactor) {
            // SD: giảm xuống scaleFactor (0.7 = 70%) của kích thước gốc
            // trunc(iw*0.7/2)*2 đảm bảo kích thước chẵn (yêu cầu của libx264)
            const f = preset.scaleFactor;
            outputOpts.push(`-vf scale=trunc(iw*${f}/2)*2:trunc(ih*${f}/2)*2`);
        }
        // HD (scaleDown=false): không thêm bộ lọc scale → giữ nguyên gốc

        // Nếu videoBitrate = '0' (HD gốc): dùng CRF để giữ chất lượng
        if (preset.videoBitrate === '0') {
            outputOpts.push('-crf 18');
        } else {
            outputOpts.push(`-b:v ${preset.videoBitrate}`);
        }
        outputOpts.push(
            `-b:a ${preset.audioBitrate}`,
            '-codec:v libx264',
            '-codec:a aac',
            '-preset veryfast',
            '-profile:v baseline',
            '-level 3.0',
            '-start_number 0',
            '-hls_time 6',
            '-hls_list_size 0',
            `-hls_segment_filename ${path.join(outputDir, 'seg_%03d.ts')}`,
            '-f hls'
        );

        const cmd = ffmpeg(inputPath)
            .outputOptions(outputOpts)
            .output(m3u8)
            .on('start', () => {
                console.log(`[FFmpeg] Encoding ${qualityName} for video ${videoId}...`);
                if (onProgress) onProgress(1);
            })
            .on('progress', (progress) => {
                let pct = 0;
                if (totalDuration > 0 && progress.timemark) {
                    pct = Math.min(99, Math.round((timemarkToSeconds(progress.timemark) / totalDuration) * 100));
                } else if (progress.percent > 0) {
                    pct = Math.min(99, Math.round(progress.percent));
                }
                if (pct > lastReported) {
                    lastReported = pct;
                    if (onProgress) onProgress(pct);
                }
            })
            .on('end', () => {
                console.log(`[FFmpeg] ${qualityName} done for video ${videoId}`);
                runningCommands.delete(videoId);
                resolve(m3u8);
            })
            .on('error', (err) => {
                runningCommands.delete(videoId);
                reject(err);
            });

        // Lưu vào map để có thể kill sau
        runningCommands.set(videoId, cmd);
        cmd.run();
    });
}

/**
 * Kill ffmpeg process đang chạy cho một video ID (nếu có)
 */
function killFFmpeg(videoId) {
    const cmd = runningCommands.get(videoId);
    if (cmd) {
        console.log(`[FFmpeg] Killing process for video ${videoId}`);
        try {
            cmd.kill('SIGKILL');
        } catch (e) {
            console.error(`[FFmpeg] Failed to kill process ${videoId}: ${e.message}`);
        }
        runningCommands.delete(videoId);
        return true;
    }
    return false;
}

/**
 * Generate master.m3u8 referencing all quality streams
 */
function writeMasterPlaylist(outputDir, qualities) {
    let content = '#EXTM3U\n#EXT-X-VERSION:3\n';
    for (const q of qualities) {
        const preset = QUALITY_PRESETS[q];
        if (!preset) continue;
        // HD không có kích thước cố định, bỏ qua RESOLUTION nếu không có
        if (preset.scaleDown !== false && preset.width && preset.height) {
            content += `#EXT-X-STREAM-INF:BANDWIDTH=${preset.bandwidth},RESOLUTION=${preset.width}x${preset.height},NAME="${q}"\n`;
        } else {
            content += `#EXT-X-STREAM-INF:BANDWIDTH=${preset.bandwidth},NAME="${q}"\n`;
        }
        content += `${q}/index.m3u8\n`;
    }
    fs.writeFileSync(path.join(outputDir, 'master.m3u8'), content, 'utf8');
}

/**
 * Convert video to multi-quality HLS
 * @param {string} inputPath
 * @param {string} hlsBase - base dir (e.g. storage/hls)
 * @param {string} videoId
 * @param {string[]} qualities - e.g. ['480p', '720p']
 * @param {Function} [onProgress] - (percent: number) called with overall %
 * @returns {Promise<string>} - path to master.m3u8
 */
async function convertToHLS(inputPath, hlsBase, videoId, qualities, onProgress) {
    // Default to sd if not specified
    if (!qualities || qualities.length === 0) qualities = ['sd'];

    const totalDuration = await getVideoDuration(inputPath);
    const videoDir = path.join(hlsBase, videoId);
    fs.mkdirSync(videoDir, { recursive: true });

    const total = qualities.length;

    for (let i = 0; i < total; i++) {
        const q = qualities[i];
        const preset = QUALITY_PRESETS[q];
        if (!preset) {
            console.warn(`[FFmpeg] Unknown quality: ${q}, skipping`);
            continue;
        }

        const qDir = path.join(videoDir, q);
        // Per-quality progress maps to overall %: quality i covers [i/total .. (i+1)/total]
        await encodeQuality(inputPath, qDir, preset, q, totalDuration, (pct) => {
            const overall = Math.round((i / total) * 100 + (pct / total));
            if (onProgress) onProgress(Math.min(99, overall));
        }, videoId);
    }

    // Write master playlist
    writeMasterPlaylist(videoDir, qualities);
    console.log(`[FFmpeg] master.m3u8 written for video ${videoId} (qualities: ${qualities.join(', ')})`);

    return path.join(videoDir, 'master.m3u8');
}

/**
 * Generate thumbnail from video
 */
function generateThumbnail(inputPath, outputDir, filename) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(outputDir, { recursive: true });
        ffmpeg(inputPath)
            .screenshots({
                count: 1,
                folder: outputDir,
                filename: filename,
                size: '640x360',
                timemarks: ['10%']
            })
            .on('end', () => {
                resolve(path.join(outputDir, filename));
            })
            .on('error', (err) => {
                console.error('[FFmpeg] Thumbnail error:', err.message);
                reject(err);
            });
    });
}

module.exports = { convertToHLS, generateThumbnail, killFFmpeg, QUALITY_PRESETS };
