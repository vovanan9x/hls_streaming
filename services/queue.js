/**
 * services/queue.js
 * FIFO encode queue — hỗ trợ:
 *   - Local encode (fallback khi không có worker)
 *   - Remote worker dispatch song song: N workers → N jobs đồng thời
 *   - Cancel job đang chạy hoặc đang chờ
 *
 * Parallel model:
 *   - remoteJobs: Map(videoId → { worker, dispatchedAt }) — jobs đang chạy
 *   - activeWorkerUrls: Set<url> — workers đang có job (cập nhật SYNCHRONOUSLY)
 *     → Đây là guard chính để tránh 2 jobs vào cùng 1 worker
 *   - localRunning: boolean — chỉ 1 local job tại 1 thời điểm
 */

const EventEmitter = require('events');

class EncodeQueue extends EventEmitter {
    constructor() {
        super();
        this.queue = [];                    // pending jobs (FIFO)
        this.localRunning = false;
        this.current = null;
        this._cancelled = new Set();
        this.remoteJobs = new Map();        // videoId → { worker, dispatchedAt }
        this.activeWorkerUrls = new Set();  // URLs đang có job (sync guard)
        this._dispatching = false;
    }

    push(job) {
        if (this.queue.some(j => j.videoId === job.videoId)) return 0;
        if (this.remoteJobs.has(job.videoId)) return 0;

        this.queue.push(job);
        const pos = this.queue.length - 1;
        console.log(`[Queue] Video ${job.videoId} added at pos=${pos + 1} | queue=${this.queue.length} | remoteActive=${this.remoteJobs.size}`);
        this._next();
        return pos;
    }

    get size() { return this.queue.length; }
    get currentId() { return this.current; }

    snapshot() {
        return this.queue.map((j, i) => ({ videoId: j.videoId, position: i + 1 }));
    }

    cancel(videoId) {
        if (this.remoteJobs.has(videoId)) {
            const { worker } = this.remoteJobs.get(videoId);
            const { cancelOnWorker } = require('./workerPool');
            cancelOnWorker(worker, videoId).catch(() => { });
            this._freeRemoteSlot(videoId);
            console.log(`[Queue] Cancelled remote job videoId=${videoId}`);
            this._next();
            return 'cancelled_running';
        }

        const idx = this.queue.findIndex(j => j.videoId === videoId);
        if (idx !== -1) {
            this.queue.splice(idx, 1);
            console.log(`[Queue] Video ${videoId} removed from queue`);
            this.emit('cancel', videoId);
            return 'cancelled_queued';
        }

        if (this.current === videoId) {
            this._cancelled.add(videoId);
            this.emit('cancel', videoId);
            return 'cancelled_running';
        }

        return 'not_found';
    }

    isCancelled(videoId) { return this._cancelled.has(videoId); }
    clearCancel(videoId) { this._cancelled.delete(videoId); }

    /**
     * Đăng ký worker URL cho 1 job — gọi SYNCHRONOUSLY trước khi dispatch HTTP
     * Đây là lock chính để tránh double-dispatch vào cùng worker
     */
    claimWorkerSlot(workerUrl, videoId, workerObj) {
        this.activeWorkerUrls.add(workerUrl);
        this.remoteJobs.set(videoId, { worker: workerObj, dispatchedAt: new Date() });
        console.log(`[Queue] Worker slot claimed: ${workerUrl} → videoId=${videoId} | active=${this.remoteJobs.size}`);
    }

    /**
     * Gọi khi remote worker báo xong
     */
    markRemoteDone(videoId) {
        const hadJob = this.remoteJobs.has(videoId);
        this._freeRemoteSlot(videoId);
        if (hadJob) {
            console.log(`[Queue] Remote slot freed (videoId=${videoId}) | remoteActive=${this.remoteJobs.size} | queued=${this.queue.length}`);
            this._next();
        }
    }

    _freeRemoteSlot(videoId) {
        const info = this.remoteJobs.get(videoId);
        if (info && info.worker) {
            this.activeWorkerUrls.delete(info.worker.url);
        }
        this.remoteJobs.delete(videoId);
    }

    async _next() {
        if (this._dispatching) return;
        if (this.queue.length === 0) return;

        const { getWorkers } = require('./workerPool');
        const maxConcurrent = Math.max(1, getWorkers().length);

        // activeWorkerUrls là synchronous lock — chính xác hơn remoteJobs.size
        if (this.activeWorkerUrls.size >= maxConcurrent && !this.localRunning) {
            console.log(`[Queue] _next() skip: all ${maxConcurrent} workers claimed (active=${this.activeWorkerUrls.size})`);
            return;
        }

        this._dispatching = true;
        try {
            await this._drainQueue();
        } finally {
            this._dispatching = false;
        }
    }

    async _drainQueue() {
        const { getWorkers } = require('./workerPool');
        const maxConcurrent = Math.max(1, getWorkers().length);

        while (this.queue.length > 0) {
            const job = this.queue[0];

            if (this._cancelled.has(job.videoId)) {
                this.queue.shift();
                this._cancelled.delete(job.videoId);
                continue;
            }

            // Dừng nếu tất cả worker slots đã claimed (synchronous check)
            if (this.activeWorkerUrls.size >= maxConcurrent) {
                console.log(`[Queue] All ${maxConcurrent} slots claimed, waiting...`);
                break;
            }

            if (this.localRunning) break;

            this.queue.shift();
            this.emit('start', job.videoId);
            console.log(`[Queue] Processing videoId=${job.videoId} | queue=${this.queue.length} | remote=${this.remoteJobs.size}/${maxConcurrent}`);

            try {
                await this._processVideo(
                    job.videoId, job.videoFilePath, job.videoFileName,
                    job.autoThumb, job.qualities, job.sourceUrl
                );

                if (this.remoteJobs.has(job.videoId)) {
                    // Dispatched remote → check xem còn slot không
                    if (this.activeWorkerUrls.size < maxConcurrent) {
                        continue;
                    } else {
                        break;
                    }
                } else {
                    // Local encode completed
                    this.emit('done', job.videoId);
                    this.localRunning = false;
                    this.current = null;
                }
            } catch (err) {
                this.localRunning = false;
                this.current = null;
                if (this._cancelled.has(job.videoId)) {
                    this._cancelled.delete(job.videoId);
                } else {
                    console.error(`[Queue] Video ${job.videoId} failed:`, err.message);
                    this.emit('error', job.videoId, err);
                }
            }

            break;
        }
    }

    setProcessor(fn) {
        this._processVideo = fn;
    }
}

const encodeQueue = new EncodeQueue();
module.exports = { encodeQueue };
