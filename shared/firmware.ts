/*
 * Firmware versions as the devices report them: KIBBL-AIR-1.2.0-8858b7f9 (product, version
 * number, commit), older cameras KIBBL-6c8f35e6 without a number.
 */

function numberOf(version: string | undefined) {
    const m = /-(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version ?? '');
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/* Whether a device on `current` should take `release`: a higher version number; without a
 * number on either side, any other build. Never back to an older one. */
export function isNewer(release: string, current: string | undefined) {
    if (!current) return true;
    if (release === current) return false;
    const r = numberOf(release);
    const c = numberOf(current);
    if (!r || !c) return true;
    for (let i = 0; i < 3; i++) {
        if (r[i] !== c[i]) return r[i] > c[i];
    }
    return false; // the same number, another build: not newer
}
