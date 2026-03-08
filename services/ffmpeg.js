const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const path = require('path');
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Quality presets
const QUALITY_PRESETS = {
    '360p': { width: 640, height: 360, videoBitrate: '800k', audioBitrate: '96k', bandwidth: 896000 },
    '480p': { width: 854, height: 480, videoBitrate: '1400k', audioBitrate: '128k', bandwidth: 1536000 },
    '720p': { width: 1280, height: 720, videoBitrate: '2800k', audioBitrate: '128k', bandwidth: 2944000 },
    '1080p': { width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k', bandwidth: 5248000 },
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

/**
 * Encode a single quality stream to HLS
 */
function encodeQuality(inputPath, outputDir, preset, qualityName, totalDuration, onProgress) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(outputDir, { recursive: true });
        const m3u8 = path.join(outputDir, 'index.m3u8');
        let lastReported = -1;

        ffmpeg(inputPath)
            .outputOptions([
                `-vf scale=${preset.width}:${preset.height}:force_original_aspect_ratio=decrease,pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2`,
                `-b:v ${preset.videoBitrate}`,
                `-b:a ${preset.audioBitrate}`,
                '-codec:v libx264',
                '-codec:a aac',
                '-profile:v baseline',
                '-level 3.0',
                '-start_number 0',
                '-hls_time 6',
                '-hls_list_size 0',
                `-hls_segment_filename ${path.join(outputDir, 'seg_%03d.ts')}`,
                '-f hls'
            ])
            .output(m3u8)
            .on('start', () => {
                console.log(`[FFmpeg] Encoding ${qualityName}...`);
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
                console.log(`[FFmpeg] ${qualityName} done`);
                resolve(m3u8);
            })
            .on('error', reject)
            .run();
    });
}

/**
 * Generate master.m3u8 referencing all quality streams
 */
function writeMasterPlaylist(outputDir, qualities) {
    let content = '#EXTM3U\n#EXT-X-VERSION:3\n';
    for (const q of qualities) {
        const preset = QUALITY_PRESETS[q];
        if (!preset) continue;
        content += `#EXT-X-STREAM-INF:BANDWIDTH=${preset.bandwidth},RESOLUTION=${preset.width}x${preset.height},NAME="${q}"\n`;
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
    // Default to 720p if not specified
    if (!qualities || qualities.length === 0) qualities = ['720p'];

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
        });
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

module.exports = { convertToHLS, generateThumbnail, QUALITY_PRESETS };
