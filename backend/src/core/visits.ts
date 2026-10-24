import { findCat, markCat } from './catDetector';
import { Device } from './db';
import { logger } from './logger';
import { notifyOwner } from './notify';
import { feederWatchedBy } from '../petkit/service';

/*
 * An e-mail (and a push message, when ntfy is set up) when something comes to a camera whose
 * motion settings ask for it (motion.notify): at the feeder (a kibbl. feeder, or a camera that
 * watches a PetKit feeder), the cat. Once a visit: after a mail
 * the camera stays quiet for VISIT_GAP_MS, a meal of ten minutes is one mail.
 *
 * While something moves, a frame every CHECK_GAP_MS goes to the cat detector (catDetector.ts,
 * YOLOX on the server): the first one with a cat sends the mail, with her box drawn on it. A
 * hand, a person or the light changing sends nothing. Without the detection model every
 * movement is a visit. No picture is stored.
 */

const log = logger('visits');

const VISIT_GAP_MS = 20 * 60_000;
const CHECK_GAP_MS = 1500;

const lastMail = new Map<string, number>();
const lastCheck = new Map<string, number>();
const checking = new Set<string>();

// a frame of a movement in progress (from its confirmation on), at the motion analysis rate
export function onMovement(deviceId: string, jpeg: Buffer, notify: boolean | undefined) {
    if (!notify) return;
    const now = Date.now();
    if (checking.has(deviceId) || now - (lastMail.get(deviceId) ?? 0) < VISIT_GAP_MS || now - (lastCheck.get(deviceId) ?? 0) < CHECK_GAP_MS) return;
    lastCheck.set(deviceId, now);
    checking.add(deviceId);
    check(deviceId, jpeg, now)
        .catch((err) => log.error('visit not checked', { device: deviceId }, err))
        .finally(() => checking.delete(deviceId));
}

async function check(deviceId: string, jpeg: Buffer, time: number) {
    const cat = await findCat(jpeg);
    if (cat === null) return; // the detector saw no cat in this frame: the next one is looked at
    lastMail.set(deviceId, time);

    const doc = await Device.findById(deviceId, { name: 1, caps: 1 }).lean();
    if (!doc) return;
    const petkit = await feederWatchedBy(deviceId).catch(() => undefined);
    const feeder = doc.caps?.includes('feeder') || !!petkit;
    const when = new Date(time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Europe/Berlin' });
    const title = cat ? (feeder ? 'The cat is at the feeder' : `A cat at ${doc.name}`) : `Something moved at ${doc.name}`;
    // with a PetKit feeder: what it gave today, so the mail says whether she found food
    const given = petkit?.feeder ? ` ${petkit.feeder.name} gave ${petkit.feeder.givenToday} portion${petkit.feeder.givenToday === 1 ? '' : 's'} today.` : '';
    const text = cat
        ? `${title}: ${doc.name} saw her at ${when} (${Math.round(cat.score * 100)} % sure).${given}`
        : `Something moved in front of ${doc.name} at ${when}.`;
    const picture = cat ? await markCat(jpeg, cat) : jpeg;
    await notifyOwner(deviceId, { title, text, email: true, picture, tag: 'cat', path: `/camera/${deviceId}`, light: 'cat' });
    log.info('visit told', { device: deviceId, cat: cat ? cat.score.toFixed(2) : 'no detector' });
}
