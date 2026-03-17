const { getDb } = require('../database');

/**
 * Chọn server SFTP active có ÍT video nhất
 * @returns {Object|null} server object hoặc null nếu không có server nào
 */
function pickLeastLoadedServer() {
    const db = getDb();
    return db.prepare(`
        SELECT s.id, s.label, s.ip, s.port, s.username, s.storage_path, s.cdn_url,
               COUNT(v.id) as video_count
        FROM servers s
        LEFT JOIN videos v ON v.server_id = s.id AND v.status = 'ready'
        WHERE s.is_active = 1 AND s.server_type = 'sftp'
        GROUP BY s.id
        ORDER BY video_count ASC, s.id ASC
        LIMIT 1
    `).get();
}

/**
 * Lấy stats tổng hợp cho tất cả servers
 * @returns {Array} servers với video_count và cdn_count
 */
function getServerStats() {
    const db = getDb();
    return db.prepare(`
        SELECT s.*,
            COUNT(DISTINCT v.id) as video_count,
            COUNT(DISTINCT c.id) as cdn_count,
            0 as total_bytes
        FROM servers s
        LEFT JOIN videos v ON v.server_id = s.id AND v.status = 'ready'
        LEFT JOIN cdn_domains c ON c.server_id = s.id AND c.is_active = 1
        GROUP BY s.id
        ORDER BY s.id
    `).all();
}

module.exports = { pickLeastLoadedServer, getServerStats };
