// everything a device or a user typed passes through here before it reaches innerHTML
export function escapeHtml(value: unknown) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function errorAlert(msg: string) {
    return `<div class="alert alert-danger" role="alert"><div class="d-flex"><i class="ti ti-alert-circle me-2"></i><div>${escapeHtml(msg)}</div></div></div>`;
}

export function successAlert(msg: string) {
    return `<div class="alert alert-success" role="alert"><div class="d-flex"><i class="ti ti-check me-2"></i><div>${escapeHtml(msg)}</div></div></div>`;
}

export function loadingHtml(msg = 'Loading') {
    return `<div class="center-loading text-center">
        <div class="text-secondary h2 mb-3">${escapeHtml(msg)}<span class="animated-dots"></span></div>
        <div class="progress progress-sm mx-auto" style="max-width: 320px"><div class="progress-bar progress-bar-indeterminate"></div></div>
    </div>`;
}

export function emptyState(icon: string, title: string, text: string, action = '') {
    return `<div class="empty">
        <div class="empty-icon"><i class="ti ti-${icon}" style="font-size: 3rem"></i></div>
        <p class="empty-title">${escapeHtml(title)}</p>
        <p class="empty-subtitle text-secondary">${escapeHtml(text)}</p>
        ${action ? `<div class="empty-action">${action}</div>` : ''}
    </div>`;
}

export function isDarkMode() {
    return document.documentElement.getAttribute('data-bs-theme') === 'dark';
}

export function setTheme(theme: 'dark' | 'light') {
    document.documentElement.setAttribute('data-bs-theme', theme);
    try {
        localStorage.setItem('theme', theme);
    } catch {
        // private mode: the choice lasts for this page only
    }
    window.dispatchEvent(new CustomEvent('themechange'));
}

export function timeAgo(time: number) {
    const s = Math.round((Date.now() - time) / 1000);
    if (s < 45) return 'just now';
    if (s < 90) return '1 min ago';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function formatDuration(seconds: number) {
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m} min ${Math.round(seconds % 60)} s`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function formatTime(time: number) {
    return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(time: number) {
    return new Date(time).toLocaleString([], { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatUptime(seconds: number) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function signalQuality(rssi: number | undefined) {
    if (rssi === undefined) return { label: 'unknown', color: 'secondary', icon: 'wifi-off' };
    if (rssi >= -60) return { label: 'excellent', color: 'green', icon: 'wifi' };
    if (rssi >= -70) return { label: 'good', color: 'lime', icon: 'wifi' };
    if (rssi >= -80) return { label: 'weak', color: 'orange', icon: 'wifi-2' };
    return { label: 'poor', color: 'red', icon: 'wifi-1' };
}

export function startOfDay(time = Date.now()) {
    const d = new Date(time);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

export function localDayKey(time: number) {
    const d = new Date(time);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* What a device's cameraError means for the person looking at the app. "init 0x105"
 * and "init 0x106" are the driver finding no camera on its cable. */
export function cameraProblem(error: string | undefined) {
    if (!error) return undefined;
    if (/init 0x10[56]/.test(error)) {
        return 'The camera module does not answer. Check that its ribbon cable sits fully in the connector, then unplug the power and plug it in again.';
    }
    return `The camera reports an error (${error}). Unplug the power and plug it in again.`;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string) {
    return document.getElementById(id) as T;
}
