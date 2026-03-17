// ========================================
// Admin Client-Side JavaScript v2
// ========================================

// ---- Global Toast System ----
window.showToast = function (type, msg, duration) {
    var root = document.getElementById('toast-root');
    if (!root) return;
    var icons = {
        success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
        error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        warn:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
    };
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.innerHTML = (icons[type] || icons.info) + '<span>' + msg + '</span>';
    root.appendChild(toast);
    setTimeout(function () {
        toast.classList.add('fade-out');
        setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 350);
    }, duration || 4000);
};

document.addEventListener('DOMContentLoaded', function () {
    initServerStatusRefresh();
});

// ---- Tab Switching (Upload Page) ----
function initTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    if (!tabBtns.length) return;

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;

            // Update buttons
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Update content
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            const content = document.getElementById(`tab-${target}`);
            if (content) content.classList.add('active');

            // Update hidden input
            const uploadTypeInput = document.getElementById('upload_type');
            if (uploadTypeInput) uploadTypeInput.value = target;
        });
    });
}

// ---- Drag & Drop Upload ----
function initDropzone() {
    const dropzone = document.getElementById('video-dropzone');
    const fileInput = document.getElementById('video-file');
    if (!dropzone || !fileInput) return;

    dropzone.addEventListener('click', () => fileInput.click());

    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files.length) {
            fileInput.files = e.dataTransfer.files;
            showFilePreview(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) {
            showFilePreview(fileInput.files[0]);
        }
    });
}

function showFilePreview(file) {
    const preview = document.getElementById('file-preview');
    if (!preview) return;

    const nameEl = preview.querySelector('.file-name');
    const sizeEl = preview.querySelector('.file-size');

    nameEl.textContent = file.name;
    sizeEl.textContent = formatSize(file.size);
    preview.classList.add('active');
}

function removeFile() {
    const fileInput = document.getElementById('video-file');
    const preview = document.getElementById('file-preview');
    if (fileInput) fileInput.value = '';
    if (preview) preview.classList.remove('active');
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ---- Thumbnail Options ----
function initThumbOptions() {
    const options = document.querySelectorAll('.thumb-option');
    if (!options.length) return;

    options.forEach(opt => {
        opt.addEventListener('click', () => {
            options.forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            const radio = opt.querySelector('input[type="radio"]');
            if (radio) radio.checked = true;

            // Show/hide thumbnail upload
            const thumbUpload = document.getElementById('thumb-upload-area');
            if (thumbUpload) {
                thumbUpload.style.display = radio.value === 'upload' ? 'block' : 'none';
            }
        });
    });
}

// ---- Delete Confirmation (Custom Modal) ----
function initDeleteConfirm() {
    const modal = document.getElementById('delete-modal');
    const modalText = document.getElementById('delete-modal-text');
    const confirmBtn = document.getElementById('delete-confirm-btn');
    const cancelBtn = document.getElementById('delete-cancel-btn');

    if (!modal) return;

    let pendingForm = null;

    // Capture every delete-form submit
    document.querySelectorAll('.delete-form').forEach(form => {
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const name = form.dataset.name || 'mục này';
            modalText.textContent = `Bạn có chắc chắn muốn xoá "${name}"? Hành động này không thể hoàn tác.`;
            pendingForm = form;
            modal.classList.add('active');
        });
    });

    // Confirm → submit the form for real
    confirmBtn.addEventListener('click', () => {
        modal.classList.remove('active');
        if (pendingForm) {
            // Remove the event listener so it doesn't loop, then submit natively
            pendingForm.removeEventListener('submit', arguments.callee);
            pendingForm.submit();
            pendingForm = null;
        }
    });

    // Cancel → close modal
    cancelBtn.addEventListener('click', () => {
        modal.classList.remove('active');
        pendingForm = null;
    });

    // Click outside modal → close
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('active');
            pendingForm = null;
        }
    });
}

// ---- Auto-refresh Server Status ----
function initServerStatusRefresh() {
    const statusBadges = document.querySelectorAll('[data-server-status]');
    if (!statusBadges.length) return;

    // Refresh every 30 seconds
    setInterval(async () => {
        try {
            const resp = await fetch('/admin/api/servers/status');
            const servers = await resp.json();

            servers.forEach(s => {
                const badge = document.querySelector(`[data-server-id="${s.id}"] .status-badge`);
                if (badge) {
                    badge.className = `badge badge-${s.status || 'unknown'} status-badge`;
                    badge.textContent = (s.status || 'unknown').toUpperCase();
                }

                const lastChecked = document.querySelector(`[data-server-id="${s.id}"] .last-checked`);
                if (lastChecked && s.last_checked) {
                    lastChecked.textContent = s.last_checked;
                }
            });
        } catch (e) {
            // silent fail
        }
    }, 30000);
}

// ---- Upload with Progress (AJAX) ----
async function uploadWithProgress(form) {
    const formData = new FormData(form);
    const progressWrap = document.querySelector('.progress-wrap');
    const progressFill = document.querySelector('.progress-fill');
    const progressText = document.querySelector('.progress-text');

    if (progressWrap) progressWrap.classList.add('active');

    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', form.action);

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                if (progressFill) progressFill.style.width = pct + '%';
                if (progressText) progressText.textContent = `${pct}% — ${formatSize(e.loaded)} / ${formatSize(e.total)}`;
            }
        });

        xhr.addEventListener('load', () => {
            if (progressFill) progressFill.style.width = '100%';
            if (progressText) progressText.textContent = 'Upload hoàn tất! Đang xử lý...';
            resolve(xhr.response);
        });

        xhr.addEventListener('error', () => reject(new Error('Upload failed')));
        xhr.send(formData);
    });
}
