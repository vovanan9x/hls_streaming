/**
 * services/queue.js
 * FIFO encode queue — chỉ encode 1 video tại một thời điểm
 * để tránh overload CPU/RAM khi nhiều video upload cùng lúc
 */

const EventEmitter = require('events');

class EncodeQueue extends EventEmitter {
    constructor() {
        super();
        this.queue = [];   // [{ videoId, videoFilePath, videoFileName, autoThumb, qualities }]
        this.running = false;
        this.current = null; // videoId đang encode
    }

    /**
     * Thêm video vào hàng đợi
     * @returns {number} vị trí trong queue (0 = đang encode ngay, 1+ = chờ)
     */
    push(job) {
        this.queue.push(job);
        const pos = this.queue.length - 1;
        console.log(`[Queue] Video ${job.videoId} added at position ${pos + (this.running ? 1 : 0)}`);
        this._next();
        return pos;
    }

    /** Số video đang chờ (không kể video đang encode) */
    get size() { return this.queue.length; }

    /** Video đang encode */
    get currentId() { return this.current; }

    /** Snapshot hàng đợi: [{videoId, position}] */
    snapshot() {
        return this.queue.map((j, i) => ({ videoId: j.videoId, position: i + 1 }));
    }

    async _next() {
        if (this.running || this.queue.length === 0) return;

        this.running = true;
        const job = this.queue.shift();
        this.current = job.videoId;

        console.log(`[Queue] Processing video ${job.videoId} (${this.queue.length} remaining)`);
        this.emit('start', job.videoId);

        try {
            // processVideo is injected to avoid circular require
            await this._processVideo(job.videoId, job.videoFilePath, job.videoFileName, job.autoThumb, job.qualities);
            this.emit('done', job.videoId);
        } catch (err) {
            console.error(`[Queue] Video ${job.videoId} failed:`, err.message);
            this.emit('error', job.videoId, err);
        } finally {
            this.running = false;
            this.current = null;
            this._next(); // process next
        }
    }

    /** Inject the processVideo function (avoids circular require) */
    setProcessor(fn) {
        this._processVideo = fn;
    }
}

const encodeQueue = new EncodeQueue();
module.exports = { encodeQueue };
