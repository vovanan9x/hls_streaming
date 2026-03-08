/**
 * Proxy HLS (m3u8 + ts) để tránh CORS khi phát từ localhost.
 * R2/CDN cần CORS, nếu chưa cấu hình thì dùng proxy này.
 */
const axios = require('axios');

// Domains được phép proxy (thêm qua env: ALLOW_PROXY_DOMAINS=domain1.com,domain2.com)
const DEFAULT_ALLOWED = ['r2.dev', 'r2.cloudflarestorage.com', 'cloudflare.com', 'workers.dev', 'vip-stream.one'];
const EXTRA = (process.env.ALLOW_PROXY_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_HOSTS = [...new Set([...DEFAULT_ALLOWED, ...EXTRA])];

function isAllowedUrl(url) {
    try {
        const u = new URL(url);
        return ALLOWED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
    } catch { return false; }
}

/** Cho phép domain từ DB (R2 public URL) */
function allowDomain(hostname) {
    if (hostname && !ALLOWED_HOSTS.includes(hostname)) {
        ALLOWED_HOSTS.push(hostname);
    }
}

/**
 * Rewrite m3u8 content: relative paths -> absolute proxy URLs
 */
function rewriteM3u8(content, baseUrl, proxyPath) {
    const base = baseUrl.replace(/\/[^/]*$/, '/'); // dir of current file
    const lines = content.split(/\r?\n/);
    const result = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const abs = new URL(trimmed, base).href;
            result.push(proxyPath + encodeURIComponent(abs));
        } else {
            result.push(line);
        }
    }
    return result.join('\n');
}

async function proxyFetch(url, proxyPath) {
    if (!isAllowedUrl(url)) {
        throw new Error('URL không được phép');
    }
    const res = await axios({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: () => true
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers['content-type'] || '';
    const isM3u8 = url.endsWith('.m3u8') || contentType.includes('mpegurl') || contentType.includes('m3u8');
    if (isM3u8) {
        const text = res.data.toString('utf8');
        const rewritten = rewriteM3u8(text, url, proxyPath);
        return { data: Buffer.from(rewritten, 'utf8'), contentType: 'application/vnd.apple.mpegurl' };
    }
    return { data: res.data, contentType: res.headers['content-type'] || 'video/mp2t' };
}

module.exports = { proxyFetch, isAllowedUrl, allowDomain };
