/**
 * services/r2.js
 * Upload HLS files lên Cloudflare R2 (S3-compatible API)
 */
const { S3Client, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

let _client = null;
let _config = null;

/**
 * Khởi tạo R2 client từ config
 * @param {{ accountId, accessKeyId, secretAccessKey, bucket, publicUrl }} cfg
 */
function init(cfg) {
    _config = cfg;
    _client = new S3Client({
        region: 'auto',
        endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey,
        },
    });
    console.log('[R2] Client initialized, bucket:', cfg.bucket);
}

function getConfig() { return _config; }
function isConfigured() { return !!(_client && _config && _config.bucket); }

/**
 * Upload toàn bộ folder HLS lên R2
 * @param {string} localDir  - thư mục local chứa HLS (e.g. storage/hls/5)
 * @param {string} keyPrefix - prefix trong R2 (e.g. "hls/5")
 * @returns {Promise<string>} URL của master.m3u8 trên CDN
 */
async function uploadFolder(localDir, keyPrefix) {
    if (!isConfigured()) throw new Error('R2 chưa được cấu hình');

    const files = getAllFiles(localDir);
    console.log(`[R2] Uploading ${files.length} files to ${keyPrefix}/`);

    for (const filePath of files) {
        const relative = path.relative(localDir, filePath).replace(/\\/g, '/');
        const key = `${keyPrefix}/${relative}`;
        const body = fs.readFileSync(filePath);
        const ct = mime.lookup(filePath) || 'application/octet-stream';

        await _client.send(new PutObjectCommand({
            Bucket: _config.bucket,
            Key: key,
            Body: body,
            ContentType: ct,
            CacheControl: filePath.endsWith('.m3u8') ? 'no-cache' : 'public, max-age=31536000',
        }));
    }

    const baseUrl = (_config.publicUrl || '').toString().replace(/\/$/, '');
    if (!baseUrl) throw new Error('R2 publicUrl chưa được cấu hình. Vui lòng cài đặt trong Settings.');
    const masterUrl = `${baseUrl}/${keyPrefix}/master.m3u8`;
    console.log(`[R2] Upload complete: ${masterUrl}`);
    return masterUrl;
}

/**
 * Xóa toàn bộ object theo prefix (khi xóa video)
 */
async function deleteFolder(keyPrefix) {
    if (!isConfigured()) return;
    let token;
    do {
        const list = await _client.send(new ListObjectsV2Command({
            Bucket: _config.bucket, Prefix: keyPrefix + '/', ContinuationToken: token,
        }));
        if (list.Contents && list.Contents.length > 0) {
            await _client.send(new DeleteObjectsCommand({
                Bucket: _config.bucket,
                Delete: { Objects: list.Contents.map(o => ({ Key: o.Key })) }
            }));
        }
        token = list.IsTruncated ? list.NextContinuationToken : null;
    } while (token);
    console.log(`[R2] Deleted prefix: ${keyPrefix}/`);
}

/** Test kết nối R2 bằng cách list bucket */
async function testConnection() {
    if (!_client || !_config) return false;
    try {
        await _client.send(new ListObjectsV2Command({ Bucket: _config.bucket, MaxKeys: 1 }));
        return true;
    } catch { return false; }
}

/** Lấy tất cả file trong thư mục (recursive) */
function getAllFiles(dir) {
    const result = [];
    for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) result.push(...getAllFiles(full));
        else result.push(full);
    }
    return result;
}

module.exports = { init, isConfigured, getConfig, uploadFolder, deleteFolder, testConnection };
