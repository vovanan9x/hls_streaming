const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'videos');
const THUMB_DIR = path.join(__dirname, '..', 'uploads', 'thumbnails');

// Ensure directories exist
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

/** Detect if a URL is a Google Drive link */
function isDriveUrl(url) {
    if (!url) return false;
    return /drive\.google\.com/.test(url) || /docs\.google\.com/.test(url);
}

/**
 * Download a remote file to local storage.
 * Automatically uses the unlimited Drive downloader for Drive URLs.
 * @param {string} url - Remote file URL (supports Drive and direct URLs)
 * @param {string} originalName - Original filename hint
 * @param {function} onProgress - optional (downloaded, total) progress callback
 * @returns {Promise<{filePath: string, fileName: string, method?: string}>}
 */
async function downloadRemoteFile(url, originalName, onProgress) {
    // Route Drive URLs through the unlimited Drive service
    if (isDriveUrl(url)) {
        const gdrive = require('./gdrive');
        return await gdrive.downloadDriveFileToUpload(url, onProgress);
    }

    // Standard direct URL download
    const ext = path.extname(originalName || url.split('?')[0]) || '.mp4';
    const fileName = `${crypto.randomUUID()}${ext}`;
    const filePath = path.join(UPLOAD_DIR, fileName);

    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 1800000, // 30 min timeout (was 10 min)
    });

    const totalSize = parseInt(response.headers['content-length'] || '0');
    let downloaded = 0;

    if (onProgress && totalSize > 0) {
        response.data.on('data', (chunk) => {
            downloaded += chunk.length;
            onProgress(downloaded, totalSize);
        });
    }

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve({ filePath, fileName }));
        writer.on('error', reject);
    });
}

module.exports = { downloadRemoteFile, UPLOAD_DIR, THUMB_DIR };
