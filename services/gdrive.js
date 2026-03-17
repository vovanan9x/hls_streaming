/**
 * services/gdrive.js
 * Unlimited Google Drive Download — 2-tier approach:
 *  Tier 1: Google Drive API v3 with Service Account (primary, unlimited)
 *  Tier 2: Smart public file download with virus-scan bypass (fallback)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { getSetting } = require('../database');

// ── File ID parser ────────────────────────────────────────────────────────────

/**
 * Extract Drive file ID from any known URL format.
 * Supported formats:
 *  - drive.google.com/file/d/FILE_ID/view
 *  - drive.google.com/open?id=FILE_ID
 *  - drive.google.com/uc?id=FILE_ID
 *  - drive.google.com/uc?export=download&id=FILE_ID
 *  - Raw FILE_ID (no URL)
 */
function parseFileId(url) {
    if (!url || typeof url !== 'string') return null;
    url = url.trim();

    // Already a raw ID (no slash, no dot, just alphanumeric + underscore + hyphen)
    if (/^[A-Za-z0-9_-]{20,}$/.test(url)) return url;

    // file/d/FILE_ID
    const pathMatch = url.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
    if (pathMatch) return pathMatch[1];

    // ?id=FILE_ID or &id=FILE_ID
    const idParam = url.match(/[?&]id=([A-Za-z0-9_-]+)/);
    if (idParam) return idParam[1];

    return null;
}

// ── Tier 1: Service Account API ───────────────────────────────────────────────

/**
 * Load service account credentials from settings DB.
 * Returns parsed JSON object or null.
 */
function loadServiceAccount() {
    try {
        const raw = getSetting('gdrive_service_account');
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Test if Service Account is configured and can access Drive API.
 * @returns {{ ok: boolean, email: string|null, error: string|null }}
 */
async function testServiceAccount() {
    const sa = loadServiceAccount();
    if (!sa) return { ok: false, email: null, error: 'Service Account chưa được cấu hình.' };

    try {
        const { google } = require('googleapis');
        const auth = new google.auth.GoogleAuth({
            credentials: sa,
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        });
        const drive = google.drive({ version: 'v3', auth });
        // Try listing 1 file to verify credentials work
        await drive.files.list({ pageSize: 1, fields: 'files(id)' });
        return { ok: true, email: sa.client_email || null, error: null };
    } catch (e) {
        return { ok: false, email: null, error: e.message };
    }
}

/**
 * Download a Drive file using Service Account (Tier 1).
 * @param {string} fileId - Drive file ID
 * @param {string} destPath - Local destination file path
 * @param {function} onProgress - (downloaded, total) callback
 */
async function downloadWithServiceAccount(fileId, destPath, onProgress) {
    const { google } = require('googleapis');
    const sa = loadServiceAccount();
    if (!sa) throw new Error('Service Account không được cấu hình.');

    const auth = new google.auth.GoogleAuth({
        credentials: sa,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const drive = google.drive({ version: 'v3', auth });

    // Get file metadata (name, size)
    let fileSize = 0;
    try {
        const meta = await drive.files.get({ fileId, fields: 'name,size,mimeType' });
        fileSize = parseInt(meta.data.size) || 0;
    } catch { /* ignore metadata error */ }

    // Download stream
    const res = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
    );

    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(destPath);
        let downloaded = 0;

        res.data.on('data', (chunk) => {
            downloaded += chunk.length;
            if (onProgress && fileSize > 0) {
                onProgress(downloaded, fileSize);
            }
        });
        res.data.on('error', reject);
        res.data.pipe(writer);
        writer.on('finish', () => resolve({ downloaded, fileSize }));
        writer.on('error', reject);
    });
}

// ── Tier 2: Smart public file download (bypass virus scan) ───────────────────

const GDRIVE_DOWNLOAD_BASE = 'https://drive.usercontent.google.com/download';

/**
 * Try to extract confirm token from Google's virus-scan HTML page.
 */
function extractConfirmToken(html) {
    // New format: data-confirm-button href
    const buttonMatch = html.match(/href="([^"]*confirm=([^"&]+)[^"]*)"/);
    if (buttonMatch) return buttonMatch[2];

    // Old format: input name="confirm"
    const inputMatch = html.match(/name="confirm"\s+value="([^"]+)"/);
    if (inputMatch) return inputMatch[1];

    // Query param in any link
    const queryMatch = html.match(/[?&]confirm=([A-Za-z0-9_-]+)/);
    if (queryMatch) return queryMatch[1];

    return null;
}

/**
 * Extract uuid param for newer Google Drive download URLs.
 */
function extractUuid(html) {
    const match = html.match(/[?&]uuid=([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
}

/**
 * Download a public Google Drive file, bypassing virus-scan confirmation.
 * @param {string} url - Original Drive share/download URL
 * @param {string} destPath - Local destination path
 * @param {function} onProgress - (downloaded, total) callback
 */
async function downloadPublicFile(url, destPath, onProgress) {
    const fileId = parseFileId(url);
    if (!fileId) throw new Error(`Không thể parse file ID từ URL: ${url}`);

    // Build initial download URL
    const initialUrl = `${GDRIVE_DOWNLOAD_BASE}?id=${fileId}&export=download&authuser=0`;

    const session = axios.create({
        timeout: 1800000, // 30 min
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        maxRedirects: 5,
        withCredentials: true,
    });

    // Step 1: Try direct download (small files succeed immediately)
    let response = await session.get(initialUrl, { responseType: 'arraybuffer' });

    const contentType = response.headers['content-type'] || '';

    // If we got HTML back → virus scan/confirmation page
    if (contentType.includes('text/html')) {
        const html = Buffer.from(response.data).toString('utf-8');
        const confirmToken = extractConfirmToken(html);
        const uuid = extractUuid(html);

        if (!confirmToken && !uuid) {
            // Try alternative uc?export=download URL as last resort
            const fallbackUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
            response = await session.get(fallbackUrl, { responseType: 'stream' });
        } else {
            // Step 2: Request with confirmation token
            let confirmUrl = `${GDRIVE_DOWNLOAD_BASE}?id=${fileId}&export=download&authuser=0&confirm=${confirmToken || 't'}`;
            if (uuid) confirmUrl += `&uuid=${uuid}`;
            response = await session.get(confirmUrl, { responseType: 'stream' });
        }
    } else {
        // Got file directly — convert arraybuffer response to stream for consistency
        const { Readable } = require('stream');
        const stream = new Readable();
        stream.push(Buffer.from(response.data));
        stream.push(null);
        response = { data: stream, headers: response.headers };
    }

    // Write stream to disk
    const totalSize = parseInt(response.headers['content-length'] || '0');
    let downloaded = 0;

    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(destPath);

        response.data.on('data', (chunk) => {
            downloaded += chunk.length;
            if (onProgress && totalSize > 0) {
                onProgress(downloaded, totalSize);
            }
        });
        response.data.on('error', reject);
        response.data.pipe(writer);
        writer.on('finish', () => resolve({ downloaded, fileSize: totalSize || downloaded }));
        writer.on('error', reject);
    });
}

// ── Auto-select tier download ─────────────────────────────────────────────────

/**
 * Download a Google Drive file — auto chooses Service Account (if configured)
 * or falls back to smart public download.
 *
 * @param {string} url - Any Google Drive URL or file ID
 * @param {string} destPath - Local destination path
 * @param {function} onProgress - (downloaded, total) callback
 * @returns {Promise<{ downloaded: number, fileSize: number, method: string }>}
 */
async function downloadDriveFile(url, destPath, onProgress) {
    const fileId = parseFileId(url);
    const sa = loadServiceAccount();

    if (sa && fileId) {
        try {
            console.log(`[GDrive] Using Service Account for fileId=${fileId}`);
            const result = await downloadWithServiceAccount(fileId, destPath, onProgress);
            return { ...result, method: 'service_account' };
        } catch (e) {
            console.warn(`[GDrive] SA download failed (${e.message}), falling back to public...`);
        }
    }

    // Fallback: smart public download
    console.log(`[GDrive] Using public download for url=${url}`);
    const result = await downloadPublicFile(url, destPath, onProgress);
    return { ...result, method: 'public' };
}

// ── Convenience: download to upload dir ───────────────────────────────────────

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'videos');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Download a Drive file to the uploads/videos directory.
 * @param {string} url - Drive URL
 * @param {function} onProgress - (downloaded, total) callback
 * @returns {Promise<{ filePath: string, fileName: string, method: string }>}
 */
async function downloadDriveFileToUpload(url, onProgress) {
    // Try to get original filename from metadata (SA only), fallback to uuid
    let ext = '.mp4';
    const fileId = parseFileId(url);
    const sa = loadServiceAccount();

    if (sa && fileId) {
        try {
            const { google } = require('googleapis');
            const auth = new google.auth.GoogleAuth({
                credentials: sa,
                scopes: ['https://www.googleapis.com/auth/drive.readonly'],
            });
            const drive = google.drive({ version: 'v3', auth });
            const meta = await drive.files.get({ fileId, fields: 'name' });
            const name = meta.data.name || '';
            const detectedExt = path.extname(name);
            if (detectedExt) ext = detectedExt;
        } catch { /* ignore */ }
    }

    const fileName = `${crypto.randomUUID()}${ext}`;
    const filePath = path.join(UPLOAD_DIR, fileName);

    const result = await downloadDriveFile(url, filePath, onProgress);
    return { filePath, fileName, ...result };
}

module.exports = {
    parseFileId,
    loadServiceAccount,
    testServiceAccount,
    downloadWithServiceAccount,
    downloadPublicFile,
    downloadDriveFile,
    downloadDriveFileToUpload,
};
