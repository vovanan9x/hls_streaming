/**
 * middleware/rateLimit.js
 * Simple in-memory rate limiter — không cần thêm dependency
 * Hỗ trợ dynamic config từ DB settings
 */
const { getSetting } = require('../database');

/**
 * Tạo rate limit middleware với default values
 * Nếu settingKey được cung cấp, sẽ đọc giới hạn từ DB setting
 * @param {number} defaultMax - Số request tối đa mặc định
 * @param {string} [settingKey] - Key trong DB settings để đọc dynamic max
 * @param {string} [message] - Thông báo khi bị giới hạn
 */
function rateLimit(defaultMax = 60, settingKey = null, message = 'Too many requests, please try again later.') {
    const windowMs = 60000; // 1 phút cố định
    const hits = new Map(); // ip -> { count, resetAt }

    // Dọn dẹp mỗi 5 phút
    setInterval(() => {
        const now = Date.now();
        for (const [ip, data] of hits) {
            if (now > data.resetAt) hits.delete(ip);
        }
    }, 5 * 60 * 1000);

    return (req, res, next) => {
        // Đọc max từ DB nếu có settingKey, fallback về default
        let maxRequests = defaultMax;
        if (settingKey) {
            try {
                const val = parseInt(getSetting(settingKey, ''));
                if (!isNaN(val) && val > 0) maxRequests = val;
            } catch { /* use default */ }
        }

        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const now = Date.now();

        let data = hits.get(ip);
        if (!data || now > data.resetAt) {
            data = { count: 0, resetAt: now + windowMs };
            hits.set(ip, data);
        }

        data.count++;

        // Headers thông tin rate limit
        res.set('X-RateLimit-Limit', String(maxRequests));
        res.set('X-RateLimit-Remaining', String(Math.max(0, maxRequests - data.count)));
        res.set('X-RateLimit-Reset', String(Math.ceil(data.resetAt / 1000)));

        if (data.count > maxRequests) {
            res.set('Retry-After', String(Math.ceil((data.resetAt - now) / 1000)));
            return res.status(429).json({ error: message });
        }

        next();
    };
}

module.exports = { rateLimit };
