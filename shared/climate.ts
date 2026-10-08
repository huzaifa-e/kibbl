import type { RoomKind } from './roomKind';

/*
 * The indoor climate of a kibbl. air and what it means for health, as the app shows it
 * and the server warns about it. General guidance, no medical advice:
 *
 * - temperature: the WHO recommends at least 18 °C indoors (more for the old, the very young
 *   and the ill); below 16 °C airways cool and colds become more likely. Above 26 °C the
 *   body loses water faster, above 30 °C heat stress begins.
 * - humidity: 40-60 % is healthy. Drier air dries the mucous membranes and lets flu viruses
 *   survive longer; above 60 % dust mites thrive, and where air meets cold walls it turns
 *   to mould.
 * - mould: what counts is the humidity at the coldest surfaces, not in the room. With the
 *   temperature outside the inner surface of an outer wall is estimated (temperature factor
 *   fRsi 0.7, the minimum of DIN 4108-2); 80 % relative humidity there for days lets mould
 *   grow.
 * - CO2: the German Environment Agency calls 1000-2000 ppm conspicuous (tiredness, poorer
 *   concentration) and above 2000 ppm unacceptable (headaches, poor sleep).
 */

export interface Weather {
    temperature: number; // °C
    humidity: number; // %RH
    at: number; // when it was measured
    source?: 'openweather' | 'open-meteo'; // OpenWeather asks to be named where its data is shown
    icon?: string; // tabler icon of the sky: sun, moon, cloud, cloud-rain, cloud-snow, cloud-storm, mist
    description?: string; // "overcast clouds"
}

// where a home is, for the weather outside; chosen in the settings of the app
export interface HomeLocation {
    latitude: number;
    longitude: number;
    name: string; // the place as the search found it, "Frankfurt am Main, Hesse, Germany"
}

export type HintLevel = 'good' | 'info' | 'warn' | 'alert';

export interface ClimateHint {
    id: string; // stable, for notifications: cold, hot, dry, humid, mould, co2, ...
    level: HintLevel;
    icon: string; // tabler icon
    title: string;
    text: string;
    notify?: boolean; // worth a message when it lasts
    afterMinutes?: number; // how long it lasts before the message, 30 when left out
    repeatMinutes?: number; // the same message again at the earliest after, 12 hours when left out
}

export interface IndoorAir {
    temperature?: number;
    humidity?: number;
    co2?: number;
}

const WALL_FACTOR = 0.7; // fRsi of DIN 4108-2

// saturation vapour pressure over water, hPa (Magnus)
function saturation(t: number) {
    return 6.112 * Math.exp((17.62 * t) / (243.12 + t));
}

// water in the air, g/m³: what airing exchanges, not the relative humidity
export function absoluteHumidity(t: number, rh: number) {
    return (216.7 * ((rh / 100) * saturation(t))) / (273.15 + t);
}

export function dewPoint(t: number, rh: number) {
    const g = Math.log(Math.max(rh, 1) / 100) + (17.62 * t) / (243.12 + t);
    return (243.12 * g) / (17.62 - g);
}

// the estimated temperature and relative humidity at the inner surface of an outer wall
export function wallSurface(tIn: number, rhIn: number, tOut: number) {
    const t = tOut + WALL_FACTOR * (tIn - tOut);
    const rh = Math.min(100, (rhIn * saturation(tIn)) / saturation(t));
    return { temperature: t, humidity: rh };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export function climateHints(air: IndoorAir, outdoor?: Weather | null): ClimateHint[] {
    const hints: ClimateHint[] = [];
    const t = air.temperature;
    const rh = air.humidity;

    if (t !== undefined) {
        if (t < 16) {
            hints.push({
                id: 'cold',
                level: 'alert',
                icon: 'snowflake',
                title: 'Too cold',
                text: `${round1(t)} °C: the airways cool down and colds become more likely. Heat to at least 18 °C, wear warm clothes.`,
                notify: true,
            });
        } else if (t < 18) {
            hints.push({
                id: 'cold',
                level: 'warn',
                icon: 'temperature-minus',
                title: 'Cool',
                text: `${round1(t)} °C is below the 18 °C the WHO recommends indoors: sitting still for long, you get chilled, a chance for a cold.`,
                notify: true,
            });
        } else if (t > 30) {
            hints.push({
                id: 'hot',
                level: 'alert',
                icon: 'temperature-plus',
                title: 'Heat stress',
                text: `${round1(t)} °C: drink water regularly (an extra glass every hour), avoid exertion, cool the room when it is cooler outside.`,
                notify: true,
            });
        } else if (t > 26) {
            hints.push({
                id: 'hot',
                level: 'warn',
                icon: 'glass-full',
                title: 'Hot: drink water',
                text: `${round1(t)} °C: the body loses more water than you notice. Drink before you are thirsty; sleep is lighter above 24 °C.`,
                notify: true,
            });
        } else if (t > 24) {
            hints.push({ id: 'hot', level: 'info', icon: 'glass-full', title: 'Warm', text: `${round1(t)} °C: keep a glass of water near.` });
        } else {
            hints.push({ id: 'temperature', level: 'good', icon: 'temperature', title: 'Comfortable temperature', text: `${round1(t)} °C` });
        }
    }

    if (rh !== undefined) {
        if (rh < 30) {
            hints.push({
                id: 'dry',
                level: 'warn',
                icon: 'droplet-off',
                title: 'Very dry air',
                text: `${Math.round(rh)} %: eyes and mucous membranes dry out, viruses (flu) survive longer and spread more easily. Drink, air in short bursts, a bowl of water or plants help.`,
                notify: true,
            });
        } else if (rh < 40) {
            hints.push({ id: 'dry', level: 'info', icon: 'droplet-half', title: 'Dry air', text: `${Math.round(rh)} %: a bit below the healthy 40-60 %.` });
        } else if (rh > 70) {
            hints.push({
                id: 'humid',
                level: 'alert',
                icon: 'droplets',
                title: 'Very humid',
                text: `${Math.round(rh)} %: dust mites thrive and mould grows where this air meets cold walls. Air several times a day, wide open for 5-10 minutes.`,
                notify: true,
            });
        } else if (rh > 60) {
            hints.push({
                id: 'humid',
                level: 'warn',
                icon: 'droplets',
                title: 'Humid',
                text: `${Math.round(rh)} %: above 60 % dust mites thrive; if it stays like this, mould can follow. Air after showering and cooking.`,
            });
        } else {
            hints.push({ id: 'humidity', level: 'good', icon: 'droplet', title: 'Healthy humidity', text: `${Math.round(rh)} %` });
        }
    }

    if (t !== undefined && rh !== undefined && t > 26 && rh > 60) {
        hints.push({
            id: 'muggy',
            level: 'warn',
            icon: 'mood-sick',
            title: 'Muggy',
            text: 'Warm and humid together: sweat evaporates poorly, the body cools badly. Drink, rest, keep the sun out.',
        });
    }

    if (t !== undefined && rh !== undefined && outdoor) {
        const wall = wallSurface(t, rh, outdoor.temperature);
        if (outdoor.temperature < t - 3 && wall.humidity >= 80) {
            hints.push({
                id: 'mould',
                level: 'alert',
                icon: 'virus',
                title: 'Mould risk on outer walls',
                text: `At ${round1(outdoor.temperature)} °C outside the outer walls are about ${round1(wall.temperature)} °C inside, with ${Math.round(wall.humidity)} % humidity at their surface: mould grows from 80 %. Air wide open, heat evenly, keep furniture a hand's width from outer walls.`,
                notify: true,
            });
        } else if (outdoor.temperature < t - 3 && wall.humidity >= 70) {
            hints.push({
                id: 'mould',
                level: 'warn',
                icon: 'virus',
                title: 'Damp at cold walls',
                text: `About ${Math.round(wall.humidity)} % humidity at the surface of the outer walls (${round1(wall.temperature)} °C): close to where mould starts. Window panes may mist up.`,
            });
        }

        // what airing does now: it exchanges water by the gram, not by the percent
        const inside = absoluteHumidity(t, rh);
        const outside = absoluteHumidity(outdoor.temperature, outdoor.humidity);
        if (rh > 60 && outside < inside - 1) {
            hints.push({
                id: 'airing',
                level: 'info',
                icon: 'window',
                title: 'Airing dries the room now',
                text: `Outside air holds ${round1(outside)} g/m³ of water, inside ${round1(inside)} g/m³.`,
            });
        } else if (rh > 60 && outside >= inside) {
            hints.push({
                id: 'airing',
                level: 'info',
                icon: 'window-off',
                title: 'Airing does not dry now',
                text: `Outside air is wetter (${round1(outside)} g/m³ against ${round1(inside)} g/m³ inside): air later, when it is cooler.`,
            });
        } else if (t > 25 && outdoor.temperature < t - 2) {
            hints.push({ id: 'airing', level: 'info', icon: 'window', title: 'Airing cools the room now', text: `${round1(outdoor.temperature)} °C outside.` });
        } else if (t > 25 && outdoor.temperature > t) {
            hints.push({
                id: 'airing',
                level: 'info',
                icon: 'window-off',
                title: 'Keep the windows shut',
                text: `${round1(outdoor.temperature)} °C outside is warmer: air at night or early morning.`,
            });
        } else if (t < 18 && outdoor.temperature < 10) {
            hints.push({
                id: 'airing',
                level: 'info',
                icon: 'window',
                title: 'Air in short bursts',
                text: 'Wide open for 5 minutes instead of tilted: fresh air without cooling walls and furniture down.',
            });
        }
    }

    const co2 = air.co2;
    if (co2 !== undefined) {
        if (co2 > 2000) {
            hints.push({
                id: 'co2',
                level: 'alert',
                icon: 'wind',
                title: 'Stale air',
                text: `${co2} ppm CO₂: headaches and poor sleep become likely. Air now.`,
            });
        } else if (co2 > 1000) {
            hints.push({
                id: 'co2',
                level: 'warn',
                icon: 'wind',
                title: 'Air getting thick',
                text: `${co2} ppm CO₂: tiredness and poorer concentration. Time to air.`,
            });
        } else {
            hints.push({ id: 'co2', level: 'good', icon: 'wind', title: 'Fresh air', text: `${co2} ppm CO₂` });
        }
    }

    const order: Record<HintLevel, number> = { alert: 0, warn: 1, info: 2, good: 3 };
    return hints.sort((a, b) => order[a.level] - order[b.level]);
}

/* ----------------------------------------------------------------------- */

// a reading of the last minutes, for what changes quickly: a shower, cooking
export interface RecentAir {
    at: number;
    humidity?: number;
    co2?: number;
}

export interface RoomMoment {
    hour: number; // 0-23, the home's clock
    night: boolean; // the device's night mode
}

const SHOWER_RH = 70; // %: the air of a bathroom after a shower
const SHOWER_RISE = 8; // percentage points within the window: a shower started
const DRY_RH = 60; // below it the bathroom is dry enough again
const DAMP_RH = 65; // above it for long: mould
const RECENT_MS = 20 * 60_000;
const BEDTIME_CO2 = 800; // ppm: aired well enough for the night
const SLEEP_CO2 = 1000; // ppm: above it sleep gets shallower (studies of bedrooms, e.g. Strøm-Tejsen 2016)
const SLEEP_WARM = 20; // °C: 16-19 is best for sleep
const COOKING_CO2_RISE = 400; // ppm within the window: a gas stove or many people cooking

/* The rise of a value over the last minutes: the newest reading less the lowest of them, all
 * of the device's own sensor (the value now may be tado's); value when there are none. */
function riseOf(recent: RecentAir[], key: 'humidity' | 'co2', now: number, value: number | undefined) {
    const values = recent.filter((r) => now - r.at <= RECENT_MS && r[key] !== undefined).map((r) => r[key] as number);
    if (!values.length || value === undefined) return 0;
    return values[values.length - 1] - Math.min(...values);
}

/* The advice of a room of its kind, on top of climateHints: a bathroom after a shower, a
 * bedroom before and during the night, a kitchen while cooking. replaces: the ids of the
 * general hints the room's own say better (the humidity of a bathroom is meant to rise). */
export function roomHints(kind: RoomKind | undefined, air: IndoorAir, recent: RecentAir[], moment: RoomMoment, now = Date.now()) {
    const hints: ClimateHint[] = [];
    const replaces: string[] = [];
    const t = air.temperature;
    const rh = air.humidity;
    const co2 = air.co2;

    if (kind === 'bathroom' && rh !== undefined) {
        replaces.push('humid', 'humidity');
        const rise = riseOf(recent, 'humidity', now, rh);
        // after a shower the walls are wet for a while: the shower and the damp advice say what to do about it
        if (rh > DAMP_RH || rise >= SHOWER_RISE) replaces.push('mould');
        if (rh >= SHOWER_RH || (rise >= SHOWER_RISE && rh >= DRY_RH)) {
            hints.push({
                id: 'shower',
                level: 'warn',
                icon: 'bath',
                title: 'Humid after a shower: open the window',
                text: `${Math.round(rh)} %: open the window wide for 5 to 10 minutes (the door, if it is cold outside) until it is below ${DRY_RH} %, and wipe the tiles and the shower dry. Damp that stays grows mould.`,
                notify: true,
                afterMinutes: 3,
                repeatMinutes: 60,
            });
        } else if (rh > DAMP_RH) {
            hints.push({
                id: 'damp',
                level: 'warn',
                icon: 'droplets',
                title: 'Still damp',
                text: `${Math.round(rh)} %: the moisture soaks into the joints and walls. Air again and leave the door open until it is below ${DRY_RH} %.`,
                notify: true,
                afterMinutes: 45,
                repeatMinutes: 6 * 60,
            });
        } else if (rh < DRY_RH) {
            hints.push({
                id: 'bathroom-dry',
                level: 'good',
                icon: 'bath',
                title: 'Dry enough',
                text: `${Math.round(rh)} %: no damp left from the last shower.`,
            });
        }
    }

    if (kind === 'bedroom') {
        const evening = !moment.night && moment.hour >= 20 && moment.hour <= 23;
        const asleep = moment.night || moment.hour >= 23 || moment.hour < 6;
        if (evening && ((co2 !== undefined && co2 > BEDTIME_CO2) || (t !== undefined && t > SLEEP_WARM))) {
            const why = [co2 !== undefined && co2 > BEDTIME_CO2 ? `${co2} ppm CO2` : '', t !== undefined && t > SLEEP_WARM ? `${round1(t)} °C` : '']
                .filter(Boolean)
                .join(', ');
            hints.push({
                id: 'bedtime',
                level: 'info',
                icon: 'bed',
                title: 'Air before you sleep',
                text: `${why}: air the bedroom for 5 to 10 minutes before bed. With the door shut the CO2 rises all night; below ${BEDTIME_CO2} ppm and at 16 to 19 °C sleep is deeper.`,
                notify: true,
                afterMinutes: 10,
                repeatMinutes: 20 * 60,
            });
        }
        if (asleep && co2 !== undefined && co2 > SLEEP_CO2) {
            hints.push({
                id: 'sleep-co2',
                level: 'warn',
                icon: 'zzz',
                title: 'Stuffy for sleeping',
                text: `${co2} ppm: above ${SLEEP_CO2} ppm sleep gets shallower and you wake up tired. Leave the door or a window ajar tonight.`,
            });
        }
        if (asleep && t !== undefined && t > SLEEP_WARM + 1) {
            hints.push({
                id: 'sleep-warm',
                level: 'info',
                icon: 'temperature-plus',
                title: 'Warm for sleeping',
                text: `${round1(t)} °C: 16 to 19 °C is best for sleep; turn the heating down in the bedroom.`,
            });
        }
    }

    if (kind === 'kitchen') {
        const rise = riseOf(recent, 'co2', now, co2);
        const steam = riseOf(recent, 'humidity', now, rh);
        if (rise >= COOKING_CO2_RISE || steam >= SHOWER_RISE) {
            hints.push({
                id: 'cooking',
                level: 'info',
                icon: 'tools-kitchen-2',
                title: 'Cooking: turn on the hood',
                text: `The ${rise >= COOKING_CO2_RISE ? `CO2 rose ${Math.round(rise)} ppm` : `humidity rose ${Math.round(steam)} %`} in the last minutes. Turn on the extractor hood or open a window while you cook.`,
            });
        }
    }
    return { hints, replaces };
}

// all hints of a room: the general ones and those of its kind, the most pressing first
export function allRoomHints(kind: RoomKind | undefined, air: IndoorAir, outdoor: Weather | null | undefined, recent: RecentAir[], moment: RoomMoment) {
    const own = roomHints(kind, air, recent, moment);
    const order: HintLevel[] = ['alert', 'warn', 'info', 'good'];
    return [...own.hints, ...climateHints(air, outdoor).filter((h) => !own.replaces.includes(h.id))].sort(
        (a, b) => order.indexOf(a.level) - order.indexOf(b.level),
    );
}
