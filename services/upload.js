const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'videos');
const THUMB_DIR = path.join(__dirname, '..', 'uploads', 'thumbnails');

// Ensure directories exist
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

/**
 * Download a remote file to local storage
 * @param {string} url - Remote file URL
 * @param {string} originalName - Original filename hint
 * @returns {Promise<{filePath: string, fileName: string}>}
 */
async function downloadRemoteFile(url, originalName) {
    const ext = path.extname(originalName || url.split('?')[0]) || '.mp4';
    const fileName = `${crypto.randomUUID()}${ext}`;
    const filePath = path.join(UPLOAD_DIR, fileName);

    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 600000, // 10 min timeout
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve({ filePath, fileName }));
        writer.on('error', reject);
    });
}

module.exports = { downloadRemoteFile, UPLOAD_DIR, THUMB_DIR };
