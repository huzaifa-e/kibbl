import { io } from 'socket.io-client';

export const socket = io('/', {
    path: '/browser/socket',
    transports: ['websocket'],
});

socket.on('connect_error', (err) => {
    console.error(err.message);
    if (err.message === 'Unauthorized') {
        window.location.href = '/login';
    }
});

// emits with an acknowledgement callback and resolves with what the server hands to it
export function request<T>(event: string, ...args: unknown[]): Promise<T> {
    return new Promise((resolve) => {
        socket.emit(event, ...args, (result: T) => resolve(result));
    });
}

/* The badge next to "Devices" in the sidebar: devices that wait for approval, on
 * every page that talks to the server. */
const pendingDevices = new Set<string>();

function showPendingBadge() {
    const badge = document.getElementById('nav-pending-badge');
    if (!badge) return;
    badge.textContent = String(pendingDevices.size);
    badge.style.display = pendingDevices.size ? '' : 'none';
}

socket.on('connect', async () => {
    const devices = await request<{ _id: string; status: string }[]>('getDevices');
    pendingDevices.clear();
    for (const d of devices) {
        if (d.status === 'pending') pendingDevices.add(d._id);
    }
    showPendingBadge();
});
socket.on('deviceUpdate', (d: { _id: string; status: string }) => {
    if (d.status === 'pending') pendingDevices.add(d._id);
    else pendingDevices.delete(d._id);
    showPendingBadge();
});
socket.on('deviceRemoved', (id: string) => {
    pendingDevices.delete(id);
    showPendingBadge();
});
