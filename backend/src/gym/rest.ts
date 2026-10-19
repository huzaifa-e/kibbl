import { pushMessage } from '../core/notify';
import { logger } from '../core/logger';

/*
 * The rest timer of a running workout, rung from the server: a phone freezes the page in the
 * background, so its own bell stays silent until the app is opened again. The page tells the
 * end of each rest (and every change of it); a push message goes out a moment after it, late
 * enough that a page still open has cancelled it and rung its own bell.
 */

const log = logger('gym');
const GRACE_MS = 1500;
const timers = new Map<string, NodeJS.Timeout>();

export function setRest(userID: string, until: number | null) {
    clearTimeout(timers.get(userID));
    timers.delete(userID);
    if (until === null) return;
    const timer = setTimeout(
        () => {
            timers.delete(userID);
            pushMessage({ title: 'Rest over', text: 'Time for the next set', path: '/gym', tag: 'bell' }).catch((e) =>
                log.warn('rest message not sent', {}, e),
            );
        },
        Math.max(0, until - Date.now()) + GRACE_MS,
    );
    timer.unref();
    timers.set(userID, timer);
}
