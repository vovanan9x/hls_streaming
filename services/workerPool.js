/**
 * Worker Pool — quản lý danh sách encode workers
 * App server dùng module này để:
 *   - Kiểm tra worker nào đang rảnh
 *   - Dispatch job đến worker (có thể gửi kèm file thực sự qua multipart)
 *   - Theo dõi trạng thái
 */

const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { getDb } = require('../database');

/** Lấy danh sách workers từ DB settings */
function getWorkers() {
    const db = getDb();
    const raw = db.prepare("SELECT value FROM settings WHERE key='encode_workers'").get();
    if (!raw || !raw.value) return [];
    try {
        return JSON.parse(raw.value); // [{ url, token, label }]
    } catch {
        return [];
    }
}

/** Lưu danh sách workers vào DB settings */
function saveWorkers(workers) {
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('encode_workers', ?)").run(JSON.stringify(workers));
}

/** Ping một worker, trả về { busy, job, uptime, storageOk } hoặc null nếu lỗi */
async function pingWorker(worker) {
    try {
        const r = await axios.get(`${worker.url}/status`, {
            headers: { 'x-worker-token': worker.token },
            timeout: 4000,
        });
        return { ...r.data, reachable: true };
    } catch {
        return { reachable: false, busy: true }; // coi như bận nếu không kết nối được
    }
}

/** Tìm worker rảnh đầu tiên */
async function findIdleWorker() {
    const workers = getWorkers();
    for (const w of workers) {
        const status = await pingWorker(w);
        if (status.reachable && !status.busy) {
            return w;
        }
    }
    return null; // Không có worker rảnh → dùng local queue
}

/**
 * Dispatch job đến remote worker (legacy — dùng shared storage)
 * @returns {boolean} true nếu dispatch thành công
 */
async function dispatchToWorker(worker, job) {
    try {
        const { videoId, videoFileName, qualities, autoThumb } = job;
        await axios.post(`${worker.url}/encode`, {
            videoId,
            videoFileName,
            qualities,
            autoThumb,
            callbackToken: worker.token,
        }, {
            headers: { 'x-worker-token': worker.token },
            timeout: 10000,
        });
        console.log(`[WorkerPool] Dispatched videoId=${videoId} → ${worker.url} (${worker.label})`);
        return true;
    } catch (e) {
        console.error(`[WorkerPool] Dispatch failed to ${worker.url}:`, e.message);
        return false;
    }
}

/**
 * Dispatch job đến remote worker, gửi kèm FILE thực sự qua multipart/form-data
 * Worker sẽ nhận file, encode HLS, rồi tự SFTP lên storage server.
 *
 * @param {object} worker  - { url, token, label }
 * @param {object} job     - { videoId, videoFilePath, qualities, autoThumb }
 * @param {object} serverInfo - server config từ DB { ip, port, username, password, storage_path, cdn_url }
 * @returns {boolean} true nếu dispatch thành công
 */
async function dispatchFileToWorker(worker, job, serverInfo) {
    const { videoId, videoFilePath, qualities, autoThumb } = job;

    try {
        if (!fs.existsSync(videoFilePath)) {
            console.error(`[WorkerPool] File không tồn tại: ${videoFilePath}`);
            return false;
        }

        // Chỉ truyền thông tin cần thiết, không truyền password trong log
        const serverConfig = {
            ip: serverInfo.ip,
            port: serverInfo.port || 22,
            username: serverInfo.username,
            password: serverInfo.password,
            storage_path: serverInfo.storage_path || '/var/hls-storage',
            cdn_url: serverInfo.cdn_url || '',
        };

        const form = new FormData();
        form.append('video', fs.createReadStream(videoFilePath), {
            filename: `video_${videoId}${require('path').extname(videoFilePath) || '.mp4'}`,
            contentType: 'video/mp4',
        });
        form.append('videoId', videoId.toString());
        form.append('qualities', JSON.stringify(qualities || ['sd']));
        form.append('autoThumb', autoThumb ? 'true' : 'false');
        form.append('callbackToken', worker.token);
        form.append('serverConfig', JSON.stringify(serverConfig));

        const fileSize = fs.statSync(videoFilePath).size;
        const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
        // Longer timeout for large files: min 10 min, ~10s/MB (caters for slow upload speeds)
        const timeoutMs = Math.max(600_000, Math.ceil(fileSize / (1024 * 1024)) * 10_000);

        console.log(`[WorkerPool] Uploading ${sizeMB}MB to ${worker.label} (timeout: ${Math.round(timeoutMs/1000)}s)...`);

        // Track upload progress
        let lastPctLogged = 0;
        const onUploadProgress = (progressEvent) => {
            if (progressEvent.total) {
                const pct = Math.round((progressEvent.loaded / progressEvent.total) * 100);
                if (pct >= lastPctLogged + 10) {
                    lastPctLogged = pct;
                    console.log(`[WorkerPool] Upload progress: ${pct}% (${(progressEvent.loaded / 1024 / 1024).toFixed(1)}MB / ${sizeMB}MB)`);
                }
            }
        };

        await axios.post(`${worker.url}/upload-encode`, form, {
            headers: {
                ...form.getHeaders(),
                'x-worker-token': worker.token,
            },
            timeout: timeoutMs,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            onUploadProgress,
        });

        console.log(`[WorkerPool] File dispatched videoId=${videoId} (${sizeMB}MB) → ${worker.url} (${worker.label})`);
        return true;
    } catch (e) {
        console.error(`[WorkerPool] dispatchFileToWorker failed to ${worker.url}:`, e.message);
        return false;
    }
}

/**
 * Dispatch job bằng URL — Worker tự download file rồi encode + SFTP.
 * Nhanh hơn dispatchFileToWorker vì bỏ bước App → Worker file transfer.
 *
 * @param {object} worker  - { url, token, label }
 * @param {object} job     - { videoId, sourceUrl, qualities, autoThumb }
 * @param {object} serverInfo - server config từ DB
 * @returns {boolean} true nếu dispatch thành công
 */
async function dispatchUrlToWorker(worker, job, serverInfo) {
    const { videoId, sourceUrl, qualities, autoThumb } = job;

    try {
        const serverConfig = {
            ip: serverInfo.ip,
            port: serverInfo.port || 22,
            username: serverInfo.username,
            password: serverInfo.password,
            storage_path: serverInfo.storage_path || '/var/hls-storage',
            cdn_url: serverInfo.cdn_url || '',
        };

        console.log(`[WorkerPool] Dispatching URL to ${worker.label} for videoId=${videoId}...`);

        await axios.post(`${worker.url}/download-encode`, {
            videoId,
            sourceUrl,
            qualities: JSON.stringify(qualities || ['sd']),
            autoThumb: autoThumb ? 'true' : 'false',
            callbackToken: worker.token,
            serverConfig: JSON.stringify(serverConfig),
        }, {
            headers: { 'x-worker-token': worker.token },
            timeout: 30000, // chỉ cần đợi worker respond OK, không đợi download
        });

        console.log(`[WorkerPool] URL dispatched videoId=${videoId} → ${worker.url} (${worker.label})`);
        return true;
    } catch (e) {
        console.error(`[WorkerPool] dispatchUrlToWorker failed to ${worker.url}:`, e.message);
        return false;
    }
}

/**
 * Cancel job trên worker
 */
async function cancelOnWorker(worker, videoId) {
    try {
        await axios.post(`${worker.url}/cancel`, { videoId }, {
            headers: { 'x-worker-token': worker.token },
            timeout: 5000,
        });
    } catch (e) {
        console.error(`[WorkerPool] Cancel failed:`, e.message);
    }
}

/**
 * Lấy status của tất cả workers (cho admin UI)
 */
async function getAllWorkersStatus() {
    const workers = getWorkers();
    return Promise.all(workers.map(async (w) => {
        const status = await pingWorker(w);
        return { ...w, token: undefined, ...status }; // ẩn token
    }));
}

module.exports = {
    getWorkers,
    saveWorkers,
    findIdleWorker,
    dispatchToWorker,
    dispatchFileToWorker,
    dispatchUrlToWorker,
    cancelOnWorker,
    getAllWorkersStatus,
    pingWorker
};
