import type { DeviceSummary } from '../../../shared/protocol';
import { escapeHtml } from './utils';

/* "Update available": the firmware published on the server is newer than the device's
 * (core/firmware.ts). The device takes it by itself when it is online; Install asks for it
 * now, also after tries that did not take. */

export function updateNoticeHtml(d: DeviceSummary) {
    const u = d.update;
    if (!u) return '';
    const text = u.installing
        ? `Installing ${escapeHtml(u.version)}: it restarts by itself in about a minute.`
        : d.online
          ? `New update available: ${escapeHtml(u.version)} (now ${escapeHtml(d.fw ?? 'unknown')}).`
          : `New update available: ${escapeHtml(u.version)}. It installs by itself when ${escapeHtml(d.name)} is online again.`;
    const button = !u.installing && d.online ? `<button class="btn btn-sm btn-primary ms-auto" data-install-update="${d._id}">Install now</button>` : '';
    return `<div class="alert alert-info py-2"><div class="d-flex align-items-center gap-2"><i class="ti ti-${u.installing ? 'loader-2' : 'download'}"></i><div>${text}</div>${button}</div></div>`;
}

// the Install buttons below root; result: what to show afterwards
export function bindUpdateInstall(root: HTMLElement, result?: (html: string) => void) {
    root.addEventListener('click', async (e) => {
        const el = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-install-update]');
        if (!el) return;
        e.preventDefault();
        el.disabled = true;
        const res = await fetch(`/api/devices/${el.dataset.installUpdate}/update`, { method: 'POST' }).catch(() => undefined);
        const out = res?.ok ? ((await res.json()) as { result: string }).result : 'failed';
        if (out !== 'started') {
            el.disabled = false;
            result?.(
                `<div class="alert alert-warning">${out === 'offline' ? 'The device is offline.' : out === 'current' ? 'It is already up to date.' : 'The device did not start the update.'}</div>`,
            );
        }
    });
}
