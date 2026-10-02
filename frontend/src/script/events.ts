import type { DeviceSummary, MotionEvent } from '../../../shared/protocol';
import { request } from './socket';
import { escapeHtml, formatDateTime, formatDuration, formatTime } from './utils';

declare const bootstrap: { Modal: { getOrCreateInstance(el: Element): { show(): void; hide(): void } } };

export function eventDuration(e: MotionEvent) {
    return ((e.end ?? Date.now()) - e.start) / 1000;
}

// how much of the picture moved, as the words a person would use
export function intensityLabel(score: number) {
    if (score >= 0.2) return 'large movement';
    if (score >= 0.07) return 'movement';
    return 'small movement';
}

export function eventCardHtml(e: MotionEvent, deviceName: string | undefined, isNew = false) {
    const ongoing = e.end === undefined;
    const img = e.hasSnapshot
        ? `<img src="/api/events/${e._id}/image" alt="motion at ${formatTime(e.start)}" loading="lazy" />`
        : '<div class="d-flex h-100 align-items-center justify-content-center text-secondary"><i class="ti ti-photo-off" style="font-size:2rem"></i></div>';
    return `<div class="col-6 col-md-4 col-xl-3" data-event-id="${e._id}">
        <div class="event-thumb ${isNew ? 'event-new' : ''}" data-open-event="${e._id}">
            ${img}
            ${ongoing ? '<span class="badge badge-live position-absolute top-0 start-0 m-2">now</span>' : ''}
            <div class="event-caption">
                <div class="fw-bold">${formatTime(e.start)}${deviceName ? ` · ${escapeHtml(deviceName)}` : ''}</div>
                <div class="opacity-75">${ongoing ? 'ongoing' : formatDuration(eventDuration(e))} · ${intensityLabel(e.peakScore)}</div>
            </div>
        </div>
    </div>`;
}

let modalEl: HTMLDivElement | null = null;

function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'modal modal-blur fade';
    modalEl.tabIndex = -1;
    modalEl.innerHTML = `<div class="modal-dialog modal-lg modal-dialog-centered">
        <div class="modal-content">
            <div class="modal-header">
                <h5 class="modal-title" id="event-modal-title"></h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body p-0"><img id="event-modal-img" class="w-100 d-block" alt="" /></div>
            <div class="modal-footer">
                <div class="me-auto text-secondary" id="event-modal-info"></div>
                <a class="btn" id="event-modal-download" download><i class="ti ti-download me-1"></i> Save</a>
                <button type="button" class="btn btn-outline-danger" id="event-modal-delete"><i class="ti ti-trash me-1"></i> Delete</button>
            </div>
        </div>
    </div>`;
    document.body.appendChild(modalEl);
    return modalEl;
}

/* Clicks on any [data-open-event] inside root open the event in a dialog; deleting it
 * there removes its tile and calls onDeleted. */
export function bindEventViewer(root: HTMLElement, lookup: (id: string) => { event: MotionEvent; device?: DeviceSummary } | undefined, onDeleted?: (id: string) => void) {
    root.addEventListener('click', (ev) => {
        const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-open-event]');
        if (!target) return;
        const found = lookup(target.dataset.openEvent!);
        if (!found) return;
        const { event: e, device } = found;

        const modal = ensureModal();
        modal.querySelector('#event-modal-title')!.textContent = `${device?.name ?? 'Camera'} · ${formatDateTime(e.start)}`;
        const img = modal.querySelector<HTMLImageElement>('#event-modal-img')!;
        img.src = e.hasSnapshot ? `/api/events/${e._id}/image` : '';
        img.style.display = e.hasSnapshot ? '' : 'none';
        modal.querySelector('#event-modal-info')!.textContent =
            `${e.end ? formatDuration(eventDuration(e)) : 'ongoing'} · ${intensityLabel(e.peakScore)} (${(e.peakScore * 100).toFixed(1)} % of the picture)`;
        const download = modal.querySelector<HTMLAnchorElement>('#event-modal-download')!;
        download.href = img.src;
        download.style.display = e.hasSnapshot ? '' : 'none';

        const del = modal.querySelector<HTMLButtonElement>('#event-modal-delete')!;
        del.onclick = async () => {
            del.disabled = true;
            const res = await request<{ ok: boolean }>('deleteEvent', e._id);
            del.disabled = false;
            if (res.ok) {
                document.querySelectorAll(`[data-event-id="${e._id}"]`).forEach((el) => el.remove());
                onDeleted?.(e._id);
                bootstrap.Modal.getOrCreateInstance(modal).hide();
            }
        };
        bootstrap.Modal.getOrCreateInstance(modal).show();
    });
}
