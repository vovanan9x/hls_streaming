/**
 * services/queue.js
 * FIFO encode queue — hỗ trợ:
 *   - Local encode (như cũ — fallback)
 *   - Remote worker dispatch (nếu có worker rảnh)
 *   - Cancel job đang chạy hoặc đang chờ
 */

const EventEmitter = require('events');

class EncodeQueue extends EventEmitter {
    constructor() {
        super();
        this.queue = [];            // pending jobs
        this.running = false;       // đang encode local
        this.current = null;        // videoId đang encode local
        this._cancelled = new Set();
        this.remoteJobs = new Map(); // videoId → { worker, job, dispatchedAt }
    }

    push(job) {
        this.queue.push(job);
        const pos = this.queue.length - 1;
        console.log(`[Queue] Video ${job.videoId} added at position ${pos + (this.running ? 1 : 0)}`);
        this._next();
        return pos;
    }

    get size() { return this.queue.length; }
    get currentId() { return this.current; }

    snapshot() {
        return this.queue.map((j, i) => ({ videoId: j.videoId, position: i + 1 }));
    }

    cancel(videoId) {
        // Đang chạy trên remote worker → cancel từ xa
        if (this.remoteJobs.has(videoId)) {
            const { worker } = this.remoteJobs.get(videoId);
            const { cancelOnWorker } = require('./workerPool');
            cancelOnWorker(worker, videoId).catch(() => { });
            this.remoteJobs.delete(videoId);
            console.log(`[Queue] Cancelled remote job videoId=${videoId}`);
            return 'cancelled_running';
        }

        // Đang chờ trong queue → xoá
        const idx = this.queue.findIndex(j => j.videoId === videoId);
        if (idx !== -1) {
            this.queue.splice(idx, 1);
            console.log(`[Queue] Video ${videoId} removed from queue`);
            this.emit('cancel', videoId);
            return 'cancelled_queued';
        }

        // Đang encode local → đánh dấu cancel
        if (this.current === videoId) {
            this._cancelled.add(videoId);
            console.log(`[Queue] Video ${videoId} marked for cancel (encoding locally)`);
            this.emit('cancel', videoId);
            return 'cancelled_running';
        }

        return 'not_found';
    }

    isCancelled(videoId) { return this._cancelled.has(videoId); }
    clearCancel(videoId) { this._cancelled.delete(videoId); }

    /** Gọi khi worker báo xong (từ callback route) */
    markRemoteDone(videoId) {
        this.remoteJobs.delete(videoId);
    }

    async _next() {
        if (this.queue.length === 0) return;

        // Thử dispatch sang remote worker trước
        try {
            const { findIdleWorker, dispatchToWorker } = require('./workerPool');
            const worker = await findIdleWorker();
            if (worker) {
                const job = this.queue.shift();
                if (this._cancelled.has(job.videoId)) {
                    this._cancelled.delete(job.videoId);
                    this._next();
                    return;
                }
                const ok = await dispatchToWorker(worker, job);
                if (ok) {
                    this.remoteJobs.set(job.videoId, { worker, job, dispatchedAt: new Date() });
                    // Thử tiếp → worker thứ 2 có thể cũng rảnh
                    this._next();
                    return;
                } else {
                    this.queue.unshift(job); // Dispatch thất bại → encode local
                }
            }
        } catch (e) {
            console.warn('[Queue] Worker dispatch error:', e.message);
        }

        // Fallback: encode local
        if (this.running || this.queue.length === 0) return;
        this.running = true;
        const job = this.queue.shift();
        this.current = job.videoId;

        if (this._cancelled.has(job.videoId)) {
            this._cancelled.delete(job.videoId);
            this.running = false;
            this.current = null;
            this._next();
            return;
        }

        console.log(`[Queue] Local encode videoId=${job.videoId} (${this.queue.length} remaining)`);
        this.emit('start', job.videoId);

        try {
            await this._processVideo(job.videoId, job.videoFilePath, job.videoFileName, job.autoThumb, job.qualities);
            this.emit('done', job.videoId);
        } catch (err) {
            if (this._cancelled.has(job.videoId)) {
                this._cancelled.delete(job.videoId);
            } else {
                console.error(`[Queue] Video ${job.videoId} failed:`, err.message);
                this.emit('error', job.videoId, err);
            }
        } finally {
            this.running = false;
            this.current = null;
            this._next();
        }
    }

    setProcessor(fn) {
        this._processVideo = fn;
    }
}

const encodeQueue = new EncodeQueue();
module.exports = { encodeQueue };
