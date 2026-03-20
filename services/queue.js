/**
 * services/queue.js
 * FIFO encode queue — hỗ trợ:
 *   - Local encode (fallback khi không có worker)
 *   - Remote worker dispatch song song: N workers → N jobs đồng thời
 *   - Cancel job đang chạy hoặc đang chờ
 *
 * Parallel model:
 *   - remoteJobs: Map(videoId → { worker, dispatchedAt }) — tất cả jobs đang chạy song song
 *   - localRunning: boolean — chỉ 1 local job tại 1 thời điểm
 *   - _next() được gọi liên tục để fill slots trống trên các workers
 *   - Số concurrent = số worker đang rảnh (tự điều chỉnh động)
 */

const EventEmitter = require('events');

class EncodeQueue extends EventEmitter {
    constructor() {
        super();
        this.queue = [];                // pending jobs (FIFO)
        this.localRunning = false;      // đang encode local
        this.current = null;            // videoId đang encode local
        this._cancelled = new Set();
        this.remoteJobs = new Map();    // videoId → { worker, dispatchedAt }
        this._dispatching = false;      // mutex để tránh race condition khi _next() gọi song song
    }

    push(job) {
        // Bỏ qua nếu video đã có trong queue hoặc đang remote encode
        if (this.queue.some(j => j.videoId === job.videoId)) return 0;
        if (this.remoteJobs.has(job.videoId)) return 0;

        this.queue.push(job);
        const pos = this.queue.length - 1;
        console.log(`[Queue] Video ${job.videoId} added at position ${pos + 1} | queue=${this.queue.length} | remoteActive=${this.remoteJobs.size}`);
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
            this._next(); // slot vừa trống → dispatch job tiếp
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

    /**
     * Gọi khi remote worker báo xong — giải phóng slot, dispatch job tiếp ngay
     */
    markRemoteDone(videoId) {
        const hadJob = this.remoteJobs.has(videoId);
        this.remoteJobs.delete(videoId);
        if (hadJob) {
            console.log(`[Queue] Remote slot freed (videoId=${videoId}) | remoteActive=${this.remoteJobs.size} | queued=${this.queue.length}`);
            this._next(); // fill slot vừa trống
        }
    }

    /**
     * Drive the queue: dispatch as many jobs as there are free worker slots.
     * Dùng mutex (_dispatching) để tránh race condition khi nhiều markRemoteDone
     * gọi _next() cùng lúc.
     */
    async _next() {
        if (this._dispatching) return; // đang trong _next() rồi
        if (this.queue.length === 0) return;

        this._dispatching = true;
        try {
            await this._drainQueue();
        } finally {
            this._dispatching = false;
        }
    }

    async _drainQueue() {
        // Số workers tối đa = số workers đã cấu hình
        // Mỗi worker chỉ được nhận 1 job tại 1 thời điểm
        const { getWorkers } = require('./workerPool');
        const maxConcurrent = Math.max(1, getWorkers().length);

        while (this.queue.length > 0) {
            const job = this.queue[0]; // peek, chưa shift

            if (this._cancelled.has(job.videoId)) {
                this.queue.shift();
                this._cancelled.delete(job.videoId);
                continue;
            }

            // Dừng nếu tất cả worker slots đã đầy
            if (this.remoteJobs.size >= maxConcurrent) {
                console.log(`[Queue] All ${maxConcurrent} worker slots full (remoteActive=${this.remoteJobs.size}), waiting for callback...`);
                break;
            }

            // Local encode: chỉ 1 job tại 1 lúc
            if (this.localRunning) break;

            this.queue.shift(); // lấy ra khỏi queue
            this.emit('start', job.videoId);
            console.log(`[Queue] Processing videoId=${job.videoId} | queue=${this.queue.length} | remoteActive=${this.remoteJobs.size}/${maxConcurrent}`);

            try {
                await this._processVideo(
                    job.videoId, job.videoFilePath, job.videoFileName,
                    job.autoThumb, job.qualities, job.sourceUrl
                );

                if (this.remoteJobs.has(job.videoId)) {
                    // Dispatched sang remote worker
                    console.log(`[Queue] videoId=${job.videoId} dispatched to remote | active=${this.remoteJobs.size}/${maxConcurrent}`);
                    // Chỉ tiếp tục nếu còn slot trống (< maxConcurrent)
                    if (this.remoteJobs.size < maxConcurrent) {
                        continue; // còn slot → dispatch tiếp cho worker khác
                    } else {
                        break; // đủ rồi → chờ markRemoteDone()
                    }
                } else {
                    // Local encode xong
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

            // Sau local encode → break (resume khi local xong)
            break;
        }
    }


    setProcessor(fn) {
        this._processVideo = fn;
    }
}

const encodeQueue = new EncodeQueue();
module.exports = { encodeQueue };
