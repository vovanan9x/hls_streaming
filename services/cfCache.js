const { getDb } = require('../database');

const CF_API = 'https://api.cloudflare.com/client/v4';

/**
 * Lấy Zone ID từ CF API theo domain name
 */
async function getZoneId(domain, apiToken) {
    // Extract root domain (cdn01.site.com → site.com)
    const parts = domain.split('.');
    const rootDomain = parts.slice(-2).join('.');

    const res = await fetch(`${CF_API}/zones?name=${rootDomain}`, {
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (!data.success || !data.result?.length) return null;
    return data.result[0].id;
}

/**
 * Purge CF cache cho một video cụ thể
 * @param {number} videoId 
 * @param {number} serverId
 * @returns {Object} { ok, purged, errors }
 */
async function purgeVideoCache(videoId, serverId) {
    const db = getDb();
    const domains = db.prepare(`
        SELECT * FROM cdn_domains WHERE server_id = ? AND is_active = 1 AND cf_api_token IS NOT NULL AND cf_api_token != ''
    `).all(serverId);

    if (!domains.length) return { ok: true, purged: 0, errors: [] };

    const results = { ok: true, purged: 0, errors: [] };

    for (const dom of domains) {
        try {
            const zoneId = await getZoneId(dom.domain, dom.cf_api_token);
            if (!zoneId) {
                results.errors.push(`${dom.domain}: không tìm được zone ID`);
                continue;
            }

            // Purge theo prefix URL pattern
            const urlsToDelete = [
                `https://${dom.domain}/hls/${videoId}`,
                `https://${dom.domain}/hls/${videoId}/`,
            ];

            // CF Purge by prefix (Pro+) hoặc purge by URL wildcard
            const res = await fetch(`${CF_API}/zones/${zoneId}/purge_cache`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${dom.cf_api_token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prefixes: [`${dom.domain}/hls/${videoId}/`] })
            });
            const data = await res.json();

            if (data.success) {
                results.purged++;
                console.log(`[CFCache] Purged ${dom.domain}/hls/${videoId}/* ✓`);
            } else {
                // Fallback: purge by URL nếu prefix không hỗ trợ (free plan)
                const res2 = await fetch(`${CF_API}/zones/${zoneId}/purge_cache`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${dom.cf_api_token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ purge_everything: false, files: urlsToDelete })
                });
                const data2 = await res2.json();
                if (data2.success) {
                    results.purged++;
                } else {
                    results.errors.push(`${dom.domain}: ${data2.errors?.[0]?.message || 'Purge thất bại'}`);
                }
            }
        } catch (e) {
            results.errors.push(`${dom.domain}: ${e.message}`);
        }
    }

    results.ok = results.errors.length === 0;
    return results;
}

/**
 * Purge toàn bộ cache của 1 domain (dùng khi cần reset)
 */
async function purgeAllCache(cdnDomainId) {
    const db = getDb();
    const dom = db.prepare('SELECT * FROM cdn_domains WHERE id = ?').get(cdnDomainId);
    if (!dom || !dom.cf_api_token) return { ok: false, message: 'Không có API token' };

    try {
        const zoneId = await getZoneId(dom.domain, dom.cf_api_token);
        if (!zoneId) return { ok: false, message: 'Không tìm được Zone ID' };

        const res = await fetch(`${CF_API}/zones/${zoneId}/purge_cache`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${dom.cf_api_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ purge_everything: true })
        });
        const data = await res.json();
        return { ok: data.success, message: data.success ? 'Purge toàn bộ thành công' : data.errors?.[0]?.message };
    } catch (e) {
        return { ok: false, message: e.message };
    }
}

module.exports = { purgeVideoCache, purgeAllCache };
