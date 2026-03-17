/**
 * services/queue.js
 * FIFO encode queue — hỗ trợ:
 *   - Local encode (fallback khi không có worker)
 *   - Remote worker dispatch (qua processVideo → dispatchFileToWorker)
 *   - Cancel job đang chạy hoặc đang chờ
 *
 * NOTE: Việc tìm worker và dispatch file sang worker được xử lý
 *       bởi processVideo() trong routes/admin.js, KHÔNG phải ở đây.
 *       Queue chỉ đơn giản là lên lịch và gọi processor tuần tự.
 */

const EventEmitter = require('events');

class EncodeQueue extends EventEmitter {
    constructor() {
        super();
        this.queue = [];            // pending jobs
        this.running = false;       // đang encode local hoặc dispatching
        this.current = null;        // videoId đang xử lý
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
        // Cho phép queue tiếp tục xử lý job tiếp theo
        if (!this.running) {
            this._next();
        }
    }

    async _next() {
        if (this.queue.length === 0) return;
        if (this.running) return; // đang xử lý job khác

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

        console.log(`[Queue] Processing videoId=${job.videoId} (${this.queue.length} remaining in queue)`);
        this.emit('start', job.videoId);

        try {
            // processVideo() sẽ tự quyết định: dispatch sang worker hay encode local
            await this._processVideo(job.videoId, job.videoFilePath, job.videoFileName, job.autoThumb, job.qualities);

            // Nếu processVideo() return sớm (dispatched sang worker),
            // remoteJobs sẽ có entry → đánh dấu là đang chờ callback.
            // Nếu job được dispatch sang worker, ta vẫn cho queue chạy tiếp
            // (worker xử lý song song — markRemoteDone() sẽ gọi _next() sau)
            if (!this.remoteJobs.has(job.videoId)) {
                // Encode local đã xong
                this.emit('done', job.videoId);
            }
            // Nếu đang ở remoteJobs → callback của worker sẽ emit done sau
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
            this._next(); // xử lý job tiếp theo trong queue
        }
    }

    setProcessor(fn) {
        this._processVideo = fn;
    }
}

const encodeQueue = new EncodeQueue();
module.exports = { encodeQueue };
