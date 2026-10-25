import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCommand } from './control';
import { parsePrinterState, printEnded, printerShown } from './printer';

test('the printer is set with its address, serial and access code', () => {
    assert.deepEqual(cleanCommand({ cmd: 'printer_config', host: '192.168.0.40', serial: '01p00a123456789', code: 'a1b2c3d4' }), {
        cmd: 'printer_config',
        host: '192.168.0.40',
        serial: '01P00A123456789',
        code: 'a1b2c3d4',
    });
    // the code left out keeps the stored one
    assert.deepEqual(cleanCommand({ cmd: 'printer_config', host: 'printer.local', serial: 'ABC', code: '' }), {
        cmd: 'printer_config',
        host: 'printer.local',
        serial: 'ABC',
    });
    assert.deepEqual(cleanCommand({ cmd: 'printer_config', enabled: false, host: 'x' }), { cmd: 'printer_config', enabled: false });
});

test('nothing that could leave the url or the topic reaches the camera', () => {
    assert.equal(cleanCommand({ cmd: 'printer_config', host: '192.168.0.40/x', serial: 'ABC', code: '12345678' }), undefined);
    assert.equal(cleanCommand({ cmd: 'printer_config', host: '192.168.0.40', serial: 'AB/#', code: '12345678' }), undefined);
    assert.equal(cleanCommand({ cmd: 'printer_config', host: '192.168.0.40', serial: 'ABC', code: '1234 5678' }), undefined);
});

test('a printer command is one action, the light or a speed', () => {
    assert.deepEqual(cleanCommand({ cmd: 'printer', action: 'pause' }), { cmd: 'printer', action: 'pause' });
    assert.deepEqual(cleanCommand({ cmd: 'printer', light: false }), { cmd: 'printer', light: false });
    assert.deepEqual(cleanCommand({ cmd: 'printer', speed: 3 }), { cmd: 'printer', speed: 3 });
    assert.equal(cleanCommand({ cmd: 'printer', action: 'gcode_line' }), undefined);
    assert.equal(cleanCommand({ cmd: 'printer', speed: 5 }), undefined);
    assert.equal(cleanCommand({ cmd: 'printer' }), undefined);
});

test('the reported state is checked field by field', () => {
    const p = parsePrinterState({
        configured: true,
        host: '192.168.0.40',
        serial: '01P00A1',
        connected: true,
        state: 'running',
        percent: 42,
        layer: 12,
        layers: 200,
        nozzle: 219.96,
        hms: ['0300-1A00-0002-0001', 'bad'],
        ams: [{ slot: 0, type: 'PLA', color: 'ff8800', remain: 80 }, { slot: 1 }, { slot: 99 }],
        trayNow: 0,
    });
    assert.equal(p?.state, 'running');
    assert.equal(p?.nozzle, 220);
    assert.deepEqual(p?.hms, ['0300-1A00-0002-0001']);
    assert.deepEqual(p?.ams, [
        { slot: 0, type: 'PLA', color: 'FF8800', remain: 80 },
        { slot: 1, type: undefined, color: undefined, remain: undefined },
    ]);
    assert.equal(parsePrinterState({ configured: true, state: 'dancing' })?.state, 'unknown');
    assert.deepEqual(parsePrinterState({ configured: false, host: 'x' }), { configured: false });
    assert.equal(parsePrinterState({ host: 'x' }), undefined);
});

test('only an end after printing alerts', () => {
    const at = (state: string) => parsePrinterState({ configured: true, connected: true, state })!;
    assert.equal(printEnded(at('running'), at('finish')), 'finish');
    assert.equal(printEnded(at('pause'), at('failed')), 'failed');
    assert.equal(printEnded(undefined, at('finish')), undefined);
    assert.equal(printEnded(at('finish'), at('finish')), undefined);
    assert.equal(printEnded(at('idle'), at('failed')), undefined);
});

test('temperatures alone do not redraw the app', () => {
    const a = parsePrinterState({ configured: true, state: 'running', layer: 3, nozzle: 210 });
    const b = parsePrinterState({ configured: true, state: 'running', layer: 3, nozzle: 215 });
    const c = parsePrinterState({ configured: true, state: 'running', layer: 4, nozzle: 215 });
    assert.equal(printerShown(a), printerShown(b));
    assert.notEqual(printerShown(b), printerShown(c));
});
