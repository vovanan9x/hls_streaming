/**
 * services/cdnPool.js
 * 2-layer CDN routing:
 *   Layer 1 (Primary)  : Cloudflare Pro domains — deterministic pick theo videoId
 *   Layer 2 (Fallback) : BunnyCDN domain — nếu không có CF domain nào active
 *   Layer 3            : serverInfo.cdn_url (legacy)
 *   Layer 4            : IP trực tiếp
 *
 * Dùng deterministic (videoId % n) thay vì random để đảm bảo:
 *   - Cùng video luôn route về cùng CF account → cache hit tối đa
 *   - Phân tán đều 60k video ra N accounts
 */

const { getDb } = require('../database');

/**
 * Lấy tất cả Cloudflare domains đang active cho server_id
 * @param {number} serverId
 * @returns {string[]}
 */
function getCloudflareDomains(serverId) {
    const db = getDb();
    return db.prepare(
        `SELECT domain FROM cdn_domains
         WHERE server_id = ? AND is_active = 1 AND cdn_type = 'cloudflare'
         ORDER BY id ASC`
    ).all(serverId).map(r => r.domain);
}

/**
 * Lấy BunnyCDN domain đang active cho server_id (chỉ lấy 1)
 * @param {number} serverId
 * @returns {string|null}
 */
function getBunnyCdnDomain(serverId) {
    const db = getDb();
    const row = db.prepare(
        `SELECT domain FROM cdn_domains
         WHERE server_id = ? AND is_active = 1 AND cdn_type = 'bunnycdn'
         ORDER BY id ASC LIMIT 1`
    ).get(serverId);
    return row ? row.domain : null;
}

/**
 * Chọn CF domain theo videoId (deterministic round-robin)
 * Cùng videoId luôn trả về cùng domain để tối đa cache hit
 * @param {number} serverId
 * @param {number|string} videoId
 * @returns {string|null}
 */
function pickCloudflareDomain(serverId, videoId) {
    const domains = getCloudflareDomains(serverId);
    if (!domains.length) return null;
    const idx = parseInt(videoId, 10) % domains.length;
    return domains[idx];
}

/**
 * Lấy tất cả active domains (cả CF + Bunny) cho server
 * Dùng cho legacy getActiveDomains() calls
 * @param {number} serverId
 * @returns {string[]}
 */
function getActiveDomains(serverId) {
    const db = getDb();
    return db.prepare(
        `SELECT domain FROM cdn_domains WHERE server_id = ? AND is_active = 1 ORDER BY id ASC`
    ).all(serverId).map(r => r.domain);
}

/**
 * Build m3u8 URL với 2-layer CDN fallback:
 *   1. Cloudflare Pro domain (deterministic theo videoId) — Layer 1
 *   2. BunnyCDN domain — Layer 2
 *   3. serverInfo.cdn_url (legacy) — Layer 3
 *   4. IP trực tiếp — Layer 4
 *
 * @param {number} serverId
 * @param {number|string} videoId
 * @param {object} serverInfo  - row từ bảng servers (ip, cdn_url, storage_path)
 * @returns {string}
 */
function buildM3u8Url(serverId, videoId, serverInfo) {
    // Layer 1: Cloudflare domain — deterministic by videoId
    const cfDomain = pickCloudflareDomain(serverId, videoId);
    if (cfDomain) {
        return `https://${cfDomain}/hls/${videoId}/master.m3u8`;
    }

    // Layer 2: BunnyCDN fallback
    const bunnyDomain = getBunnyCdnDomain(serverId);
    if (bunnyDomain) {
        return `https://${bunnyDomain}/hls/${videoId}/master.m3u8`;
    }

    // Layer 3: Legacy cdn_url của server
    if (serverInfo && serverInfo.cdn_url && serverInfo.cdn_url.trim()) {
        const base = serverInfo.cdn_url.replace(/\/$/, '');
        return `${base}/hls/${videoId}/master.m3u8`;
    }

    // Layer 4: IP trực tiếp
    const remotePath = (serverInfo.storage_path || '').replace(/\/$/, '');
    return `http://${serverInfo.ip}:80${remotePath}/${videoId}/master.m3u8`;
}

/**
 * Trả về thông tin layer đang được sử dụng (để debug/logging)
 * @param {number} serverId
 * @param {number|string} videoId
 * @param {object} serverInfo
 * @returns {{ layer: number, type: string, domain: string }}
 */
function getRoutingInfo(serverId, videoId, serverInfo) {
    const cfDomain = pickCloudflareDomain(serverId, videoId);
    if (cfDomain) return { layer: 1, type: 'cloudflare', domain: cfDomain };

    const bunnyDomain = getBunnyCdnDomain(serverId);
    if (bunnyDomain) return { layer: 2, type: 'bunnycdn', domain: bunnyDomain };

    if (serverInfo && serverInfo.cdn_url && serverInfo.cdn_url.trim()) {
        return { layer: 3, type: 'legacy_cdn_url', domain: serverInfo.cdn_url };
    }

    return { layer: 4, type: 'direct_ip', domain: serverInfo.ip };
}

module.exports = {
    pickCloudflareDomain,
    getBunnyCdnDomain,
    getActiveDomains,
    buildM3u8Url,
    getRoutingInfo,
};
