/**
 * services/sftp.js
 * Upload toàn bộ thư mục HLS lên remote server qua SSH/SFTP
 */
const Client = require('ssh2').Client;
const fs = require('fs');
const path = require('path');

/**
 * Upload một thư mục local lên remote server qua SFTP
 * @param {Object}   serverInfo  - { ip, port, username, password, storage_path }
 * @param {string}   localDir    - Đường dẫn thư mục local cần upload
 * @param {string}   remoteName  - Tên thư mục trên server (VD: "5" cho videoId=5)
 * @param {Function} [onProgress]- Callback (filesUploaded, totalFiles, filename)
 * @returns {Promise<string>}  - Đường dẫn remote của file index.m3u8
 */
function uploadHlsToServer(serverInfo, localDir, remoteName, onProgress) {
    return new Promise((resolve, reject) => {
        const conn = new Client();

        conn.on('ready', () => {
            console.log(`[SFTP] Connected to ${serverInfo.ip}`);
            conn.sftp((err, sftp) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }

                const remoteBase = serverInfo.storage_path.replace(/\/$/, '');
                const remoteDir = `${remoteBase}/${remoteName}`;

                // Đệ quy lấy tất cả file (bao gồm thư mục con 360p, 720p, v.v.)
                const allFiles = getAllFilesRecursive(localDir);

                (async () => {
                    try {
                        // Pre-create all remote directories first (sequential to avoid mkdir races)
                        const allDirs = new Set(allFiles.map(localPath => {
                            const relative = path.relative(localDir, localPath).replace(/\\/g, '/');
                            return path.dirname(`${remoteDir}/${relative}`).replace(/\\/g, '/');
                        }));
                        await ensureRemoteDir(sftp, remoteDir);
                        for (const dir of allDirs) {
                            await ensureRemoteDir(sftp, dir);
                        }

                        // Parallel upload with concurrency limit
                        const CONCURRENCY = 8;
                        let uploaded = 0;
                        let idx = 0;
                        const total = allFiles.length;

                        async function worker() {
                            while (idx < total) {
                                const localPath = allFiles[idx++];
                                const relative = path.relative(localDir, localPath).replace(/\\/g, '/');
                                const remotePath = `${remoteDir}/${relative}`;
                                await sftpPut(sftp, localPath, remotePath);
                                uploaded++;
                                console.log(`[SFTP] Uploaded: ${relative}`);
                                if (typeof onProgress === 'function') {
                                    onProgress(uploaded, total, relative);
                                }
                            }
                        }

                        await Promise.all(
                            Array.from({ length: Math.min(CONCURRENCY, total) }, worker)
                        );

                        conn.end();
                        resolve(remoteDir);
                    } catch (uploadErr) {
                        conn.end();
                        reject(uploadErr);
                    }
                })();
            });
        });

        conn.on('error', (err) => {
            reject(new Error(`SSH connection failed: ${err.message}`));
        });

        conn.connect({
            host: serverInfo.ip,
            port: serverInfo.port || 22,
            username: serverInfo.username,
            password: serverInfo.password,
            readyTimeout: 20000
        });
    });
}

/** Lấy tất cả file trong thư mục (đệ quy, bao gồm thư mục con) */
function getAllFilesRecursive(dir) {
    const result = [];
    for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) {
            result.push(...getAllFilesRecursive(full));
        } else {
            result.push(full);
        }
    }
    return result;
}

/** Đảm bảo thư mục remote tồn tại (tạo từng cấp nếu cần) */
async function ensureRemoteDir(sftp, dirPath) {
    const normalized = dirPath.replace(/\/$/, '').replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const isAbsolute = normalized.startsWith('/');
    let current = '';
    for (const part of parts) {
        current = (current === '' && isAbsolute) ? `/${part}` : (current ? `${current}/${part}` : part);
        await new Promise((res) => sftp.mkdir(current, () => res()));
    }
}

/**
 * Promise wrapper around sftp.fastPut
 */
function sftpPut(sftp, localPath, remotePath) {
    return new Promise((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

/**
 * Kiểm tra kết nối SSH đến server
 * @param {Object} serverInfo - { ip, port, username, password }
 * @returns {Promise<boolean>}
 */
function testConnection(serverInfo) {
    return new Promise((resolve) => {
        const conn = new Client();
        const timeout = setTimeout(() => {
            conn.end();
            resolve(false);
        }, 8000);

        conn.on('ready', () => {
            clearTimeout(timeout);
            conn.end();
            resolve(true);
        });

        conn.on('error', () => {
            clearTimeout(timeout);
            resolve(false);
        });

        conn.connect({
            host: serverInfo.ip,
            port: serverInfo.port || 22,
            username: serverInfo.username,
            password: serverInfo.password,
            readyTimeout: 8000
        });
    });
}

module.exports = { uploadHlsToServer, testConnection };
