/**
 * services/cfAutoCreate.js
 * Tự động tạo tài khoản Cloudflare Free và cấu hình CDN domain
 *
 * Quy trình:
 *   1. Tạo temp email qua mail.tm API
 *   2. Puppeteer đăng ký dash.cloudflare.com/sign-up
 *   3. Xác minh email qua mail.tm
 *   4. Dùng CF API tạo zone, DNS record, deploy Worker
 *   5. Lưu kết quả vào bảng cdn_domains
 */

const { getDb } = require('../database');

// ---------- mail.tm helpers ----------

const MAILTM_API = 'https://api.mail.tm';

async function fetchJson(url, opts = {}) {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
        ...opts,
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.substring(0, 200)}`);
    }
    return res.json();
}

/**
 * Tạo tài khoản temp email
 * @returns {{ email, password, token }}
 */
async function createTempEmail() {
    // Lấy domain có sẵn từ mail.tm
    const domains = await fetchJson(`${MAILTM_API}/domains`);
    const domain = domains['hydra:member'][0].domain;

    const password = 'Temp@' + Math.random().toString(36).slice(2, 10) + '!1';
    const name = 'user' + Math.random().toString(36).slice(2, 8);
    const email = `${name}@${domain}`;

    // Tạo account
    await fetchJson(`${MAILTM_API}/accounts`, {
        method: 'POST',
        body: JSON.stringify({ address: email, password }),
    });

    // Lấy token
    const auth = await fetchJson(`${MAILTM_API}/token`, {
        method: 'POST',
        body: JSON.stringify({ address: email, password }),
    });

    return { email, password: password, token: auth.token };
}

/**
 * Chờ email từ Cloudflare (tối đa 2 phút)
 * @returns {string} verification link
 */
async function waitForVerificationLink(mailToken, timeoutMs = 120000) {
    const { default: fetch } = await import('node-fetch');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await sleep(5000);
        try {
            const res = await fetch(`${MAILTM_API}/messages`, {
                headers: { Authorization: `Bearer ${mailToken}` },
            });
            const data = await res.json();
            const messages = data['hydra:member'] || [];
            // Tìm email từ Cloudflare
            const cfMsg = messages.find(m =>
                m.from && m.from.address && m.from.address.includes('cloudflare')
            );
            if (cfMsg) {
                // Lấy nội dung đầy đủ
                const detail = await fetch(`${MAILTM_API}/messages/${cfMsg.id}`, {
                    headers: { Authorization: `Bearer ${mailToken}` },
                });
                const detailData = await detail.json();
                const body = detailData.text || detailData.html || '';
                // Tìm verify link
                const match = body.match(/https:\/\/[^\s"'<]+verify[^\s"'<]+/i)
                    || body.match(/https:\/\/[^\s"'<]+confirm[^\s"'<]+/i);
                if (match) return match[0];
            }
        } catch (e) { /* retry */ }
    }
    throw new Error('Timeout: không nhận được email xác minh từ Cloudflare sau 2 phút');
}

// ---------- Puppeteer helpers ----------

/**
 * Detect Chromium/Chrome executable on the system
 */
function findChromePath() {
    const fs = require('fs');
    const paths = [
        // Linux
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/snap/bin/chromium',
        // Mac
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        // Windows
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * Get puppeteer module + launch options
 * @returns {{ puppeteer, launchOpts }}
 */
async function getPuppeteerWithOpts() {
    let puppeteer, needsPath = false;
    try {
        puppeteer = require('puppeteer');
    } catch {
        try {
            puppeteer = require('puppeteer-core');
            needsPath = true;
        } catch {
            throw new Error(
                'Puppeteer chưa được cài đặt! Chạy: npm install puppeteer-core\n' +
                'Hoặc: npm install puppeteer (sẽ kèm Chromium, ~300MB)'
            );
        }
    }

    const launchOpts = {
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    };

    if (needsPath) {
        const chromePath = process.env.CHROME_PATH || findChromePath();
        if (!chromePath) {
            throw new Error(
                'Không tìm thấy Chrome/Chromium! Cài đặt:\n' +
                '  Ubuntu: apt install -y chromium-browser\n' +
                '  Hoặc set biến môi trường: CHROME_PATH=/path/to/chrome'
            );
        }
        launchOpts.executablePath = chromePath;
    }

    return { puppeteer, launchOpts };
}

/**
 * Đăng ký tài khoản Cloudflare qua browser
 */
async function signUpCloudflare(email, password, log) {
    const { puppeteer, launchOpts } = await getPuppeteerWithOpts();
    const browser = await puppeteer.launch(launchOpts);

    try {
        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
        );

        log('Mở trang đăng ký Cloudflare...');
        await page.goto('https://dash.cloudflare.com/sign-up', { waitUntil: 'networkidle2', timeout: 60000 });

        // Điền email
        await page.waitForSelector('input[name="email"], input[type="email"]', { timeout: 30000 });
        await page.type('input[name="email"], input[type="email"]', email, { delay: 50 });

        // Điền password
        await page.waitForSelector('input[name="password"], input[type="password"]');
        await page.type('input[name="password"], input[type="password"]', password, { delay: 50 });

        log('Điền thông tin đăng ký...');

        // Submit
        const submitBtn = await page.$('button[type="submit"]');
        if (submitBtn) await submitBtn.click();
        else await page.keyboard.press('Enter');

        // Chờ redirect (sau submit CF thường chuyển trang)
        await page.waitForNavigation({ timeout: 30000, waitUntil: 'networkidle2' }).catch(() => { });

        log('Đã submit form đăng ký');
    } finally {
        await browser.close();
    }
}

/**
 * Click vào verification link qua Puppeteer
 */
async function clickVerificationLink(verifyUrl, log) {
    const { puppeteer, launchOpts } = await getPuppeteerWithOpts();
    const browser = await puppeteer.launch(launchOpts);
    try {
        const page = await browser.newPage();
        log('Click link xác minh email...');
        await page.goto(verifyUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await sleep(3000);
        log('Xác minh email thành công!');
    } finally {
        await browser.close();
    }
}

// ---------- Cloudflare API helpers ----------

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cfRequest(method, path, apiToken, body) {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(`${CF_API}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!data.success) {
        const errMsg = (data.errors || []).map(e => e.message).join('; ');
        throw new Error(`CF API error: ${errMsg}`);
    }
    return data.result;
}

/**
 * Lấy Global API Token bằng cách login qua CF API
 * NOTE: CF không có OAuth password-flow công khai.
 * Phương án: sau khi verify email, user cần lấy API Token thủ công,
 * hoặc dùng scraping dashboard để lấy.
 * Ở đây ta ghi chú để user nhập token sau.
 */
async function getApiTokenViaScraping(email, password, log) {
    const { puppeteer, launchOpts } = await getPuppeteerWithOpts();
    const browser = await puppeteer.launch(launchOpts);
    try {
        const page = await browser.newPage();
        log('Đăng nhập CF để lấy API token...');

        // Login
        await page.goto('https://dash.cloudflare.com/login', { waitUntil: 'networkidle2', timeout: 60000 });
        await page.type('input[name="email"], input[type="email"]', email, { delay: 40 });
        await page.type('input[name="password"], input[type="password"]', password, { delay: 40 });
        await page.keyboard.press('Enter');
        await page.waitForNavigation({ timeout: 30000, waitUntil: 'networkidle2' }).catch(() => { });

        // Vào trang API tokens
        await page.goto('https://dash.cloudflare.com/profile/api-tokens', { waitUntil: 'networkidle2' });

        // Click "Create Token"
        const createBtn = await page.$('button:has-text("Create Token"), a:has-text("Create Token")');
        if (createBtn) await createBtn.click();
        await sleep(2000);

        // Chọn "Edit zone DNS" template hoặc custom
        // Simple: dùng Global API Key (không khuyến nghị nhưng đơn giản hơn)
        await page.goto('https://dash.cloudflare.com/profile/api-tokens', { waitUntil: 'networkidle2' });

        // Lấy Global API Key
        const viewBtn = await page.$('[data-testid="global-api-key-view"]');
        if (viewBtn) {
            await viewBtn.click();
            await sleep(1000);
            // Nhập password confirm
            const pwInput = await page.$('input[type="password"]');
            if (pwInput) {
                await pwInput.type(password);
                const confirmBtn = await page.$('button[type="submit"]');
                if (confirmBtn) await confirmBtn.click();
                await sleep(2000);
            }
        }

        // Extract key từ DOM
        const keyEl = await page.$('[data-testid="global-api-key-value"], .apiKey, code');
        if (keyEl) {
            const key = await page.evaluate(el => el.textContent, keyEl);
            log('Lấy được API key!');
            return { type: 'global', key: key.trim(), email };
        }

        log('Không tự động lấy được API key — cần nhập thủ công');
        return null;
    } finally {
        await browser.close();
    }
}

async function cfAddZone(apiToken, domain, log) {
    log(`Thêm zone ${domain} vào Cloudflare...`);
    const result = await cfRequest('POST', '/zones', apiToken, {
        name: domain,
        account: {},
        jump_start: false,
        type: 'full',
    });
    log(`Zone tạo thành công, ID: ${result.id}`);
    return result.id;
}

async function cfAddDnsRecord(apiToken, zoneId, hetznerIp, log) {
    log(`Thêm DNS A record → ${hetznerIp}...`);
    await cfRequest('POST', `/zones/${zoneId}/dns_records`, apiToken, {
        type: 'A',
        name: '@',
        content: hetznerIp,
        ttl: 1,
        proxied: true,
    });
    log('DNS record thêm thành công!');
}

async function cfDeployWorker(apiToken, zoneId, domain, workerScript, log) {
    log('Deploy Cloudflare Worker...');

    // Lấy account ID
    const zones = await cfRequest('GET', `/zones/${zoneId}`, apiToken);
    const accountId = zones.account?.id;
    if (!accountId) throw new Error('Không lấy được account ID từ zone');

    const workerName = 'hls-proxy-' + domain.replace(/\./g, '-');

    // Upload worker script
    const { default: fetch } = await import('node-fetch');
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('metadata', JSON.stringify({ main_module: 'worker.js', compatibility_date: '2024-01-01' }), { contentType: 'application/json' });
    form.append('worker.js', workerScript, { contentType: 'application/javascript+module', filename: 'worker.js' });

    const uploadRes = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${workerName}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${apiToken}`, ...form.getHeaders() },
        body: form,
    });
    const uploadData = await uploadRes.json();
    if (!uploadData.success) throw new Error('Deploy worker thất bại: ' + JSON.stringify(uploadData.errors));

    // Tạo worker route: domain/hls/*
    await cfRequest('POST', `/zones/${zoneId}/workers/routes`, apiToken, {
        pattern: `${domain}/hls/*`,
        script: workerName,
    });

    log(`Worker "${workerName}" deploy thành công!`);
    return workerName;
}

// ---------- CF Worker script template ----------

const CF_WORKER_SCRIPT = `
// Cloudflare Worker: rewrite Content-Type cho .png (fake TS segments)
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const response = await fetch(request);
    if (url.pathname.endsWith('.png')) {
      const headers = new Headers(response.headers);
      headers.set('Content-Type', 'video/mp2t');
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return new Response(response.body, { status: response.status, headers });
    }
    if (url.pathname.endsWith('.m3u8')) {
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'no-cache, no-store');
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  }
};
`.trim();

// ---------- Utilities ----------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomPassword() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
    let p = '';
    for (let i = 0; i < 16; i++) p += chars[Math.floor(Math.random() * chars.length)];
    return p;
}

// ---------- Main function ----------

/**
 * Tạo 1 Cloudflare account và cấu hình CDN cho domain
 * @param {object} opts
 * @param {string} opts.domain - domain cần thêm (ví dụ cdn01.site.com)
 * @param {string} opts.hetznerIp - IP origin Hetzner
 * @param {number} opts.serverId - server_id trong DB
 * @param {string} [opts.label]
 * @param {Function} opts.onLog - callback(message: string)
 * @returns {Promise<{ok: boolean, email, domain, jobId}>}
 */
async function createCloudflareAccount({ domain, hetznerIp, serverId, label, onLog }) {
    const db = getDb();
    const log = (msg) => {
        console.log(`[CFAutoCreate:${domain}] ${msg}`);
        if (onLog) onLog(msg);
    };

    // Tạo job record
    const jobRow = db.prepare(
        `INSERT INTO cf_create_jobs (domain, server_id, status, log) VALUES (?, ?, 'running', '[]')`
    ).run(domain, serverId || null);
    const jobId = jobRow.lastInsertRowid;

    const addLog = (msg) => {
        const job = db.prepare('SELECT log FROM cf_create_jobs WHERE id=?').get(jobId);
        const logs = JSON.parse(job.log || '[]');
        logs.push({ time: new Date().toISOString(), msg });
        db.prepare('UPDATE cf_create_jobs SET log=? WHERE id=?').run(JSON.stringify(logs), jobId);
        log(msg);
    };

    try {
        // Step 1: Temp email
        addLog('Tạo email tạm...');
        const { email, password: emailPass, token: mailToken } = await createTempEmail();
        addLog(`Email tạm: ${email}`);

        // Step 2: Đăng ký
        addLog('Đăng ký tài khoản Cloudflare...');
        await signUpCloudflare(email, emailPass, addLog);

        // Step 3: Chờ verify email
        addLog('Chờ email xác minh (tối đa 2 phút)...');
        const verifyLink = await waitForVerificationLink(mailToken);
        addLog('Nhận được link xác minh!');
        await clickVerificationLink(verifyLink, addLog);

        // Step 4: Lấy API token (manual step - lưu note để user nhập sau)
        addLog('⚠️ Cần lấy API token thủ công: vào dash.cloudflare.com → Profile → API Tokens → tạo token "Edit zone DNS + Workers"');
        addLog(`Thông tin đăng nhập: email=${email} | pass=${emailPass}`);

        // Lưu vào cdn_domains ở trạng thái cần nhập API token
        db.prepare(`
            INSERT INTO cdn_domains (label, domain, server_id, cf_email, cf_api_token, cf_zone_id, is_active, note)
            VALUES (?, ?, ?, ?, '', '', 0, ?)
            ON CONFLICT(domain) DO UPDATE SET
                cf_email=excluded.cf_email, server_id=excluded.server_id,
                label=excluded.label, note=excluded.note
        `).run(
            label || domain,
            domain,
            serverId || null,
            email,
            `Pass: ${emailPass} | Cần nhập API token để kích hoạt`
        );

        db.prepare(`UPDATE cf_create_jobs SET status='awaiting_token' WHERE id=?`).run(jobId);
        addLog('Đã lưu thông tin. Vui lòng nhập API token trong trang quản lý CDN để kích hoạt domain này.');

        return { ok: true, email, domain, jobId, status: 'awaiting_token' };

    } catch (err) {
        addLog(`❌ Lỗi: ${err.message}`);
        db.prepare(`UPDATE cf_create_jobs SET status='failed' WHERE id=?`).run(jobId);
        return { ok: false, error: err.message, domain, jobId };
    }
}

/**
 * Sau khi user nhập API token, hoàn tất cấu hình CF (zone, DNS, Worker)
 * @param {number} cdnDomainId - ID trong bảng cdn_domains
 * @param {string} apiToken - CF API token do user nhập
 * @param {string} hetznerIp
 * @param {Function} [onLog]
 */
async function finalizeCfSetup(cdnDomainId, apiToken, hetznerIp, onLog) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM cdn_domains WHERE id=?').get(cdnDomainId);
    if (!row) throw new Error('CDN domain không tồn tại');

    const log = (msg) => { console.log(`[CFFinalize:${row.domain}] ${msg}`); if (onLog) onLog(msg); };

    try {
        const zoneId = await cfAddZone(apiToken, row.domain, log);
        await cfAddDnsRecord(apiToken, zoneId, hetznerIp, log);
        await cfDeployWorker(apiToken, zoneId, row.domain, CF_WORKER_SCRIPT, log);

        db.prepare(`
            UPDATE cdn_domains
            SET cf_api_token=?, cf_zone_id=?, is_active=1, note='Đã cấu hình đầy đủ'
            WHERE id=?
        `).run(apiToken, zoneId, cdnDomainId);

        log('✅ Hoàn tất! Domain đã active trong CDN pool.');
        return { ok: true };
    } catch (err) {
        log(`❌ Lỗi cấu hình CF: ${err.message}`);
        throw err;
    }
}

module.exports = {
    createCloudflareAccount,
    finalizeCfSetup,
    CF_WORKER_SCRIPT,
};
