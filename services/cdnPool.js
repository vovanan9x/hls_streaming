/**
 * services/cdnPool.js
 * Quản lý pool CDN domains (nhiều tài khoản Cloudflare free)
 * Chọn domain theo round-robin ngẫu nhiên cho từng server
 */

const { getDb } = require('../database');

/**
 * Lấy tất cả CDN domains đang active cho server_id
 * @param {number} serverId
 * @returns {string[]} mảng domain
 */
function getActiveDomains(serverId) {
    const db = getDb();
    return db.prepare(
        `SELECT domain FROM cdn_domains WHERE server_id = ? AND is_active = 1 ORDER BY id ASC`
    ).all(serverId).map(r => r.domain);
}

/**
 * Chọn ngẫu nhiên 1 CDN domain từ pool của server
 * Trả về null nếu không có domain nào
 * @param {number} serverId
 * @returns {string|null}
 */
function pickDomain(serverId) {
    const domains = getActiveDomains(serverId);
    if (!domains.length) return null;
    return domains[Math.floor(Math.random() * domains.length)];
}

/**
 * Tạo m3u8 URL với CDN domain từ pool (hoặc fallback về origin)
 * @param {number} serverId
 * @param {string|number} videoId
 * @param {object} serverInfo  - row từ bảng servers (có ip, cdn_url, storage_path)
 * @returns {string}
 */
function buildM3u8Url(serverId, videoId, serverInfo) {
    const cdnDomain = pickDomain(serverId);
    if (cdnDomain) {
        return `https://${cdnDomain}/hls/${videoId}/master.m3u8`;
    }
    // Fallback: cdn_url cũ của server (nếu có)
    if (serverInfo.cdn_url && serverInfo.cdn_url.trim()) {
        const base = serverInfo.cdn_url.replace(/\/$/, '');
        return `${base}/hls/${videoId}/master.m3u8`;
    }
    // Fallback cuối: IP trực tiếp
    const remotePath = (serverInfo.storage_path || '').replace(/\/$/, '');
    return `http://${serverInfo.ip}:80${remotePath}/${videoId}/master.m3u8`;
}

module.exports = { pickDomain, getActiveDomains, buildM3u8Url };
