import { productName, type DeviceSummary, type SetupInfo, type WifiNetwork } from '../../../shared/protocol';
import { request, socket } from './socket';
import { UsbDevice, type DeviceResponse } from './usbSerial';
import { errorAlert, escapeHtml, signalQuality } from './utils';

declare const bootstrap: { Modal: { getOrCreateInstance(el: Element, options?: object): { show(): void; hide(): void } } };

const JOIN_TIMEOUT_MS = 40_000; // wifi joined (ip address) after sending the network
const ONLINE_TIMEOUT_MS = 60_000; // in the app after the device restarted

// ─────────────────────────── the dialog ───────────────────────────
let modalEl: HTMLDivElement | null = null;
let onHidden: (() => void) | null = null;

function modal(title: string) {
    if (!modalEl) {
        modalEl = document.createElement('div');
        modalEl.className = 'modal modal-blur fade';
        modalEl.tabIndex = -1;
        modalEl.innerHTML = `<div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-header"><h5 class="modal-title"></h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
                <div class="modal-body"></div>
            </div>
        </div>`;
        document.body.appendChild(modalEl);
        modalEl.addEventListener('hidden.bs.modal', () => {
            onHidden?.();
            onHidden = null;
        });
    }
    modalEl.querySelector('.modal-title')!.textContent = title;
    bootstrap.Modal.getOrCreateInstance(modalEl, { backdrop: 'static' }).show();
    return modalEl.querySelector<HTMLDivElement>('.modal-body')!;
}

function closeModal() {
    if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).hide();
}

// ─────────────────────────── network picker ───────────────────────────
function networkPickerHtml(networks: WifiNetwork[] | undefined, current?: string) {
    const options = (networks ?? [])
        .map((n) => {
            const q = signalQuality(n.rssi);
            return `<option value="${escapeHtml(n.ssid)}" data-secure="${n.secure}" ${n.ssid === current ? 'selected' : ''}>${escapeHtml(n.ssid)} · ${q.label}${n.secure ? '' : ' · open'}</option>`;
        })
        .join('');
    return `<div class="mb-3">
            <label class="form-label d-flex"><span class="flex-fill">Wi-Fi network</span>
                <a href="#" class="small" data-wifi-rescan>${networks ? 'scan again' : ''}</a></label>
            <select class="form-select" data-wifi-ssid-select ${networks ? '' : 'disabled'}>
                ${networks ? options + '<option value="">Other network…</option>' : '<option>Scanning for networks…</option>'}
            </select>
            <input type="text" class="form-control mt-2" data-wifi-ssid-input maxlength="32" placeholder="Network name (SSID)" style="display: none" autocomplete="off" />
        </div>
        <div class="mb-3">
            <label class="form-label">Password</label>
            <div class="input-group">
                <input type="password" class="form-control" data-wifi-password maxlength="63" autocomplete="new-password" placeholder="8 to 63 characters, empty for an open network" />
                <button class="btn" type="button" data-wifi-show title="Show the password"><i class="ti ti-eye"></i></button>
            </div>
            <div class="form-hint">Goes straight to the device; the server never stores it. The device connects to 2.4 GHz networks.</div>
        </div>`;
}

function bindNetworkPicker(root: HTMLElement, rescan: () => void) {
    const select = root.querySelector<HTMLSelectElement>('[data-wifi-ssid-select]')!;
    const input = root.querySelector<HTMLInputElement>('[data-wifi-ssid-input]')!;
    const password = root.querySelector<HTMLInputElement>('[data-wifi-password]')!;
    const sync = () => {
        input.style.display = select.value === '' && !select.disabled ? '' : 'none';
    };
    select.addEventListener('change', sync);
    sync();
    root.querySelector('[data-wifi-show]')!.addEventListener('click', () => {
        password.type = password.type === 'password' ? 'text' : 'password';
    });
    root.querySelector('[data-wifi-rescan]')?.addEventListener('click', (e) => {
        e.preventDefault();
        rescan();
    });
}

function readNetworkPicker(root: HTMLElement): { ssid: string; password: string } | string {
    const select = root.querySelector<HTMLSelectElement>('[data-wifi-ssid-select]')!;
    const ssid = select.value || root.querySelector<HTMLInputElement>('[data-wifi-ssid-input]')!.value.trim();
    const password = root.querySelector<HTMLInputElement>('[data-wifi-password]')!.value;
    if (!ssid || ssid.length > 32) return 'Choose a network, or type its name.';
    if (password.length > 0 && (password.length < 8 || password.length > 63)) return 'A Wi-Fi password has 8 to 63 characters.';
    const secure = select.selectedOptions[0]?.dataset.secure;
    if (secure === 'true' && !password) return 'This network needs a password.';
    return { ssid, password };
}

function stepHtml(state: 'wait' | 'run' | 'ok' | 'fail', text: string) {
    const icon = { wait: 'ti-circle text-secondary', run: 'ti-loader-2 text-orange', ok: 'ti-circle-check text-green', fail: 'ti-circle-x text-red' }[state];
    return `<li class="d-flex align-items-start gap-2 mb-2"><i class="ti ${icon} mt-1" ${state === 'run' ? 'style="animation: spin 1s linear infinite"' : ''}></i><span>${text}</span></li>`;
}

// ─────────────────────────── setup over USB ───────────────────────────
/* Plug in, pick the port, name it, choose the Wi-Fi: the app writes network and
 * server address over the cable, tells the server to approve the device on its first
 * connection, and waits until it is online. The password never leaves this browser
 * except over the cable. */
export async function setupOverUsb(devices: () => DeviceSummary[], port?: Parameters<typeof UsbDevice.open>[0]) {
    const body = modal('Set up a device over USB');
    body.innerHTML = `<p>Plug the device into this computer with its USB cable, then choose it in the list your browser shows.</p>
        <div class="text-secondary small">Opening the port restarts the device; it answers after a few seconds.</div>`;

    let device: UsbDevice;
    try {
        device = port ? await UsbDevice.open(port) : await UsbDevice.choose();
    } catch (err) {
        body.innerHTML = errorAlert(
            err instanceof DOMException && err.name === 'NotFoundError' ? 'No port chosen.' : `The port could not be opened: ${(err as Error).message}`,
        );
        return;
    }
    let finished = false;
    onHidden = () => {
        finished = true;
        device.close();
    };

    body.innerHTML = `<div class="text-center py-4"><div class="spinner-border text-orange mb-3"></div><div>Waiting for the device to start…</div></div>`;
    const info = await device.info();
    if (finished) return;
    if (!info) {
        body.innerHTML = errorAlert('The device does not answer. Unplug it, plug it in again and retry.');
        return;
    }

    const id = String(info.deviceId ?? '');
    // a kibbl. air (the CO2 traffic light) or a camera
    const isAir = Array.isArray(info.caps) && (info.caps as string[]).includes('air');
    const known = devices().find((d) => d._id === id);
    const setup = await request<SetupInfo>('getSetupInfo');
    const serverUrl = setup.deviceSocketUrl ?? String(info.server ?? '');
    let networks: WifiNetwork[] | undefined;

    const renderForm = (message = '') => {
        body.innerHTML = `
            <div class="d-flex align-items-center mb-3">
                <span class="hud-icon hud-pumpkin me-3"><i class="ti ti-${isAir ? 'wind' : 'device-cctv'}"></i></span>
                <div>
                    <div class="fw-bold">${escapeHtml(productName(info.model as string | undefined, (info.caps as string[]) ?? []))}</div>
                    <div class="text-secondary small"><span class="text-mono">${escapeHtml(id)}</span> · ${escapeHtml(info.fw ?? '')}</div>
                    <div class="text-secondary small">${info.ip ? `on <b>${escapeHtml(info.ssid)}</b> (${escapeHtml(info.ip)})` : info.ssid ? `set to <b>${escapeHtml(info.ssid)}</b>, not connected` : 'no Wi-Fi yet'}${known ? ` · known as <b>${escapeHtml(known.name)}</b>` : ''}</div>
                </div>
            </div>
            ${message}
            <div class="mb-3">
                <label class="form-label">Name</label>
                <input type="text" class="form-control" id="usb-name" maxlength="40" value="${escapeHtml(known?.name ?? `${isAir ? 'Air' : 'Camera'} ${id.slice(-4)}`)}" />
            </div>
            ${networkPickerHtml(networks, String(info.ssid ?? ''))}
            <details class="mb-3">
                <summary class="text-secondary small">Server address</summary>
                <input type="text" class="form-control mt-2 text-mono small" id="usb-server" value="${escapeHtml(serverUrl)}" />
                <div class="form-hint">Where the device connects to, as it reaches the server from your home network.${setup.deviceSocketUrl ? '' : ' The server has no DEVICE_BASE_URL set, so this is what the device had.'}</div>
            </details>
            <div id="usb-error"></div>
            <button class="btn btn-primary w-100" id="usb-save"><i class="ti ti-device-floppy me-1"></i> Save to the device</button>`;
        bindNetworkPicker(body, scan);
        body.querySelector('#usb-save')!.addEventListener('click', save);
    };

    const scan = async () => {
        networks = undefined;
        renderForm();
        const resp = await device.send({ cmd: 'wifi_scan' }, 12000);
        if (finished) return;
        networks = resp?.ok ? (resp.networks as WifiNetwork[]) : [];
        renderForm(resp?.ok ? '' : `<div class="text-secondary small mb-2">No scan result: type the network name below.</div>`);
    };

    const save = async () => {
        const name = body.querySelector<HTMLInputElement>('#usb-name')!.value.trim();
        const server = body.querySelector<HTMLInputElement>('#usb-server')!.value.trim();
        const wifi = readNetworkPicker(body);
        const error = body.querySelector('#usb-error')!;
        if (!name) return void (error.innerHTML = errorAlert('Give the device a name.'));
        if (typeof wifi === 'string') return void (error.innerHTML = errorAlert(wifi));
        if (!/^wss?:\/\/.+/.test(server)) return void (error.innerHTML = errorAlert('The server address starts with ws:// or wss://.'));

        const steps = [
            ['run', 'Telling the server to expect this device'],
            ['wait', `Sending <b>${escapeHtml(wifi.ssid)}</b> to the device`],
            ['wait', 'Writing the server address'],
            ['wait', `Joining <b>${escapeHtml(wifi.ssid)}</b>`],
            ['wait', `Waiting for <b>${escapeHtml(name)}</b> to come online`],
        ] as [Parameters<typeof stepHtml>[0], string][];
        const show = (extra = '') => {
            body.innerHTML = `<ul class="list-unstyled mb-3">${steps.map(([s, t]) => stepHtml(s, t)).join('')}</ul>${extra}`;
        };
        const fail = (k: number, why: string) => {
            steps[k][0] = 'fail';
            show(errorAlert(why) + '<button class="btn w-100" id="usb-back"><i class="ti ti-arrow-left me-1"></i> Back</button>');
            body.querySelector('#usb-back')!.addEventListener('click', () => renderForm());
        };
        const next = (k: number, text?: string) => {
            steps[k][0] = 'ok';
            if (text) steps[k][1] = text;
            if (steps[k + 1]) steps[k + 1][0] = 'run';
            show();
        };
        show();

        const expected = await request<{ ok: boolean; error?: string }>('expectDevice', id, name);
        if (!expected.ok) return fail(0, expected.error ?? 'The server refused.');
        next(0);

        const wifiResp = await device.send({ cmd: 'wifi', ssid: wifi.ssid, password: wifi.password }, 8000);
        wifi.password = '';
        if (!wifiResp?.ok) return fail(1, wifiResp?.error ?? 'The device did not answer.');
        next(1);

        // the device reads the server address at boot: it restarts when it changes
        if (server !== info.server) {
            const serverResp = await device.send({ cmd: 'server', url: server }, 5000);
            if (!serverResp?.ok) return fail(2, serverResp?.error ?? 'The device did not take the address.');
            next(2, 'Server address written, the device restarts');
        } else {
            next(2, 'Server address already set');
        }

        // joined: the device reports an ip address on the chosen network
        const joinUntil = Date.now() + JOIN_TIMEOUT_MS;
        let joined: DeviceResponse | undefined;
        while (!finished && Date.now() < joinUntil) {
            await new Promise((r) => setTimeout(r, 2000));
            const now = await device.send({ cmd: 'info' }, 1500);
            if (now?.ip && now.ssid === wifi.ssid) {
                joined = now;
                break;
            }
        }
        if (finished) return;
        if (!joined) return fail(3, `The device did not join ${wifi.ssid}. Check the password, and that it is a 2.4 GHz network in reach.`);
        next(3, `Joined <b>${escapeHtml(wifi.ssid)}</b> as ${escapeHtml(joined.ip)}`);

        // online: the server reports it connected
        const online = await new Promise<boolean>((resolve) => {
            const already = devices().find((d) => d._id === id && d.online && d.status === 'approved');
            if (already) return resolve(true);
            const listener = (d: DeviceSummary) => {
                if (d._id === id && d.online && d.status === 'approved') {
                    socket.off('deviceUpdate', listener);
                    clearTimeout(timer);
                    resolve(true);
                }
            };
            const timer = setTimeout(() => {
                socket.off('deviceUpdate', listener);
                resolve(false);
            }, ONLINE_TIMEOUT_MS);
            socket.on('deviceUpdate', listener);
        });
        if (finished) return;
        if (!online) return fail(4, `${name} is on the Wi-Fi but does not reach ${server}. Is that address reachable from your home network?`);
        next(4, `<b>${escapeHtml(name)}</b> is online`);
        show(
            isAir
                ? `<div class="text-secondary mb-3">You can unplug the adapter and put it where it should measure the air.</div>
            <a class="btn btn-primary w-100" href="/air/${escapeHtml(id)}"><i class="ti ti-wind me-1"></i> Open it</a>`
                : `<div class="text-secondary mb-3">You can unplug it and put it where it should watch.</div>
            <a class="btn btn-primary w-100" href="/camera/${escapeHtml(id)}"><i class="ti ti-video me-1"></i> Open the live view</a>`,
        );
    };

    renderForm();
    scan();
}

// ─────────────────────────── Wi-Fi of an online device ───────────────────────────
/* Changes the network of a device that is online, through the server. The device
 * goes back to its current network when the new one gives it no address in 30 s. */
export async function changeWifiRemotely(device: DeviceSummary) {
    const body = modal(`Wi-Fi of ${device.name}`);
    let networks: WifiNetwork[] | undefined;

    const render = (message = '') => {
        body.innerHTML = `<p class="text-secondary">Now on <b>${escapeHtml(device.ssid ?? 'unknown')}</b>. If the new network does not work within 30 s, the device goes back to it by itself.</p>
            ${message}
            ${networkPickerHtml(networks, device.ssid)}
            <div id="wifi-error"></div>
            <button class="btn btn-primary w-100" id="wifi-save"><i class="ti ti-wifi me-1"></i> Switch network</button>`;
        bindNetworkPicker(body, scan);
        body.querySelector('#wifi-save')!.addEventListener('click', save);
    };

    const scan = async () => {
        networks = undefined;
        render();
        const resp = await request<DeviceResponse>('deviceCommand', device._id, { cmd: 'wifi_scan' });
        networks = resp.ok ? (resp.networks as WifiNetwork[]) : [];
        render(resp.ok ? '' : `<div class="text-secondary small mb-2">${escapeHtml(resp.error ?? 'No scan result')}: type the network name below.</div>`);
    };

    const save = async () => {
        const wifi = readNetworkPicker(body);
        if (typeof wifi === 'string') {
            body.querySelector('#wifi-error')!.innerHTML = errorAlert(wifi);
            return;
        }
        const resp = await request<DeviceResponse>('deviceCommand', device._id, { cmd: 'wifi', ssid: wifi.ssid, password: wifi.password });
        if (!resp.ok) {
            body.querySelector('#wifi-error')!.innerHTML = errorAlert(resp.error ?? 'The device did not take it.');
            return;
        }
        body.innerHTML = `<ul class="list-unstyled">${stepHtml('run', `Switching to <b>${escapeHtml(wifi.ssid)}</b>…`)}</ul>`;
        const result = await new Promise<DeviceSummary | undefined>((resolve) => {
            const listener = (d: DeviceSummary) => {
                if (d._id === device._id && d.online && (d.ssid === wifi.ssid || d.wifiChangeFailed === wifi.ssid)) {
                    socket.off('deviceUpdate', listener);
                    clearTimeout(timer);
                    resolve(d);
                }
            };
            const timer = setTimeout(() => {
                socket.off('deviceUpdate', listener);
                resolve(undefined);
            }, 90_000);
            socket.on('deviceUpdate', listener);
        });
        if (result && result.ssid === wifi.ssid && !result.wifiChangeFailed) {
            body.innerHTML = `<ul class="list-unstyled">${stepHtml('ok', `${escapeHtml(device.name)} is online on <b>${escapeHtml(wifi.ssid)}</b>.`)}</ul>`;
        } else if (result) {
            body.innerHTML = `<ul class="list-unstyled">${stepHtml('fail', `It could not join <b>${escapeHtml(wifi.ssid)}</b> and went back to <b>${escapeHtml(result.ssid ?? '')}</b>. Check the password.`)}</ul>`;
        } else {
            body.innerHTML = errorAlert(`${device.name} has not come back yet. If ${wifi.ssid} works but cannot reach the server, set it up again over USB.`);
        }
    };

    render();
    scan();
}

export { closeModal };
