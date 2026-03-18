/**
 * services/signedUrl.js
 * Tạo Signed URL cho HLS stream bảo vệ chống hotlink
 * 
 * Format: url?token=BASE64URL(md5(expires + uri + secret))&expires=UNIX_TIMESTAMP
 * Tương thích với nginx secure_link_md5 "$arg_expires$uri SECRET"
 */
const crypto = require('crypto');
const { URL } = require('url');

/**
 * Sign một URL với token + expires
 * @param {string} originalUrl - URL gốc (VD: https://st1.ahay.stream/hls/24/master.m3u8)
 * @param {string} secret      - Secret key chia sẻ với nginx
 * @param {number} ttlSeconds  - Thời hạn (giây), mặc định 4 giờ
 * @returns {string} URL đã sign với ?token=...&expires=...
 */
function signUrl(originalUrl, secret, ttlSeconds = 14400) {
    if (!secret || !originalUrl) return originalUrl;

    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const parsed = new URL(originalUrl);
    const uri = parsed.pathname; // VD: /hls/24/master.m3u8

    // md5(expires + uri + secret) → binary → base64url
    const hash = crypto
        .createHash('md5')
        .update(expires + uri + secret)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    parsed.searchParams.set('token', hash);
    parsed.searchParams.set('expires', expires.toString());
    return parsed.toString();
}

module.exports = { signUrl };
