/**
 * services/viewers.js
 * Track số người đang xem mỗi video theo thời gian thực (in-memory)
 * Mỗi viewer ping mỗi 15s, nếu không ping trong 35s thì bị xóa (offline)
 */

// Map<videoId, Map<sessionKey, lastPingTime>>
const viewers = new Map();

const TIMEOUT_MS = 35000; // 35 seconds

/**
 * Ghi nhận một viewer đang xem video
 * @param {string|number} videoId
 * @param {string} sessionKey - unique per viewer (IP + user-agent hash)
 */
function pingViewer(videoId, sessionKey) {
    const id = String(videoId);
    if (!viewers.has(id)) {
        viewers.set(id, new Map());
    }
    viewers.get(id).set(sessionKey, Date.now());
}

/**
 * Dọn dẹp các viewer đã không ping quá TIMEOUT_MS
 */
function cleanExpired() {
    const now = Date.now();
    for (const [videoId, sessions] of viewers.entries()) {
        for (const [key, lastSeen] of sessions.entries()) {
            if (now - lastSeen > TIMEOUT_MS) {
                sessions.delete(key);
            }
        }
        if (sessions.size === 0) {
            viewers.delete(videoId);
        }
    }
}

/**
 * Lấy số viewers hiện tại của một video
 * @param {string|number} videoId
 * @returns {number}
 */
function getViewerCount(videoId) {
    cleanExpired();
    const id = String(videoId);
    return viewers.has(id) ? viewers.get(id).size : 0;
}

/**
 * Lấy tất cả viewer counts hiện tại { videoId: count }
 * @returns {Object}
 */
function getAllViewerCounts() {
    cleanExpired();
    const result = {};
    for (const [videoId, sessions] of viewers.entries()) {
        if (sessions.size > 0) {
            result[videoId] = sessions.size;
        }
    }
    return result;
}

// Chạy cleanup mỗi 30 giây
setInterval(cleanExpired, 30000);

module.exports = { pingViewer, getViewerCount, getAllViewerCounts };
