import Anthropic from '@anthropic-ai/sdk';
import { Device } from './db';
import { logger } from './logger';
import { notifyOwner } from './notify';

/*
 * An e-mail (and a push message, when ntfy is set up) when something comes to a camera whose
 * motion settings ask for it (motion.notify): at the feeder, the cat. Once a visit: after a mail
 * the camera stays quiet for VISIT_GAP_MS, a meal of ten minutes is one mail.
 *
 * With ANTHROPIC_API_KEY on the server, Claude looks at the picture of the movement first and
 * says whether a cat is in it and whether it eats; only a cat sends a mail. A hand, a person or
 * the light changing does not, and the next movement is looked at again, at most every
 * CHECK_GAP_MS. Without the key every movement is a visit. Nothing of the picture is stored.
 */

const log = logger('visits');

const VISIT_GAP_MS = 20 * 60_000;
const CHECK_GAP_MS = 2 * 60_000;
const MODEL = 'claude-opus-5-5';

interface Seen {
    cat: boolean;
    eating: boolean;
}

const lastMail = new Map<string, number>();
const lastCheck = new Map<string, number>();
let client: Anthropic | undefined;

function claude() {
    if (!process.env.ANTHROPIC_API_KEY) return undefined;
    client ??= new Anthropic();
    return client;
}

// a movement was confirmed on a camera, with the frame that confirmed it
export function onMovement(deviceId: string, jpeg: Buffer, notify: boolean | undefined) {
    if (!notify) return;
    const now = Date.now();
    if (now - (lastMail.get(deviceId) ?? 0) < VISIT_GAP_MS || now - (lastCheck.get(deviceId) ?? 0) < CHECK_GAP_MS) return;
    lastCheck.set(deviceId, now);
    visit(deviceId, jpeg, now).catch((err) => log.error('visit not told', { device: deviceId }, err));
}

async function visit(deviceId: string, jpeg: Buffer, time: number) {
    const doc = await Device.findById(deviceId, { name: 1, caps: 1 }).lean();
    if (!doc) return;
    const feeder = doc.caps?.includes('feeder');
    const seen = await lookAt(jpeg, feeder);
    if (seen && !seen.cat) {
        log.info('movement without a cat', { device: deviceId });
        return;
    }
    lastMail.set(deviceId, time);

    const at = feeder ? 'at the feeder' : `at ${doc.name}`;
    const title = seen?.eating ? 'The cat is eating' : seen ? `The cat is ${at}` : `Something moved ${at}`;
    const when = new Date(time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Europe/Berlin' });
    const text = seen
        ? `${title} (${doc.name}, ${when}).`
        : `Something moved in front of ${doc.name} at ${when}. (Set ANTHROPIC_API_KEY on the server and only the cat sends a mail.)`;
    await notifyOwner(deviceId, { title, text, email: true, picture: jpeg, tag: 'cat', path: `/camera/${deviceId}` });
    log.info('visit told', { device: deviceId, cat: seen ? String(seen.cat) : 'not checked', eating: seen ? String(seen.eating) : 'not checked' });
}

/* Claude on the picture: is a cat in it, does it eat. undefined without a key or when the
 * answer is unusable: then the movement counts as a visit, a mail too many beats one missed. */
async function lookAt(jpeg: Buffer, feeder: boolean): Promise<Seen | undefined> {
    const api = claude();
    if (!api) return undefined;
    try {
        const response = await api.beta.messages.create({
            model: MODEL,
            max_tokens: 2048,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: {
                effort: 'low',
                format: {
                    type: 'json_schema',
                    schema: {
                        type: 'object',
                        properties: { cat: { type: 'boolean' }, eating: { type: 'boolean' } },
                        required: ['cat', 'eating'],
                        additionalProperties: false,
                    },
                },
            },
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
                        {
                            type: 'text',
                            text:
                                `A home camera${feeder ? ' on a cat feeder, looking at its bowl,' : ''} saw something move: this is the frame. ` +
                                'Is a cat in the picture (even partly, close to the lens, blurred or only its head)? ' +
                                'eating: true if the cat has its head in or at the bowl or food.',
                        },
                    ],
                },
            ],
        });
        if (response.stop_reason === 'refusal') return undefined;
        const text = response.content.find((b) => b.type === 'text');
        if (!text || text.type !== 'text') return undefined;
        const seen = JSON.parse(text.text) as Seen;
        return { cat: seen.cat === true, eating: seen.eating === true };
    } catch (err) {
        if (err instanceof Anthropic.APIError) {
            log.warn('Claude did not look at the picture', { status: err.status, error: err.message });
        } else {
            log.warn('Claude did not look at the picture', { error: String(err) });
        }
        return undefined;
    }
}
