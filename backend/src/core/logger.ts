/* eslint-disable security-node/detect-crlf */
import chalk from 'chalk';

/*
 * One line per event, in columns, for `docker compose logs`:
 *
 *   2026-10-06 10:42:53.039  WARN   device   silent for 35 s, closing                device=C82E1824CFA8
 *   2026-10-06 10:43:01.552  INFO   auth     logged in                               user=a@b.de ip=100.81.234.79
 *
 * time in the server's time zone (TZ), level, the part of the server that speaks,
 * what happened, then the details as key=value. An unexpected error is followed by
 * its stack, indented.
 *
 *   LOG_LEVEL  debug | info | warn | error   (default: info, debug outside production)
 *   LOG_COLOR  auto | always | never         (default: auto, colours on a terminal only)
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Record<string, string | number | boolean | undefined | null>;

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SCOPE_WIDTH = 8;
const MESSAGE_WIDTH = 40;
const STACK_FRAMES = 8;

export const isDev = () => process.env.NODE_ENV !== 'production';

function minLevel(): number {
    const configured = process.env.LOG_LEVEL?.toLowerCase() as Level | undefined;
    if (configured && configured in LEVELS) return LEVELS[configured];
    return isDev() ? LEVELS.debug : LEVELS.info;
}

function colors() {
    const mode = process.env.LOG_COLOR?.toLowerCase();
    if (mode === 'always') return new chalk.Instance({ level: 1 });
    if (mode === 'never') return new chalk.Instance({ level: 0 });
    return chalk;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function formatTime(date: Date) {
    return (
        `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
        `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`
    );
}

// one line, whatever a device or a user sent: no line breaks or control characters (log injection)
export function clean(text: string) {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

export function formatValue(value: string | number | boolean) {
    const text = clean(String(value));
    return text === '' || /[\s="]/.test(text) ? JSON.stringify(text) : text;
}

function fieldEntries(fields: Fields | undefined) {
    return Object.entries(fields ?? {}).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== null);
}

export function formatFields(fields: Fields | undefined, c: chalk.Chalk = new chalk.Instance({ level: 0 })) {
    return fieldEntries(fields)
        .map(([k, v]) => `${c.gray(k + '=')}${formatValue(v)}`)
        .join(' ');
}

export function formatLine(level: Level, scope: string, message: string, fields?: Fields, date = new Date(), c: chalk.Chalk = colors()) {
    const levelColor = { debug: c.gray, info: c.blue, warn: c.yellow, error: c.red }[level];
    const msg = clean(message);
    const details = formatFields(fields, c);
    const text = details ? msg.padEnd(MESSAGE_WIDTH) : msg;
    return (
        `${c.gray(formatTime(date))}  ${levelColor(level.toUpperCase().padEnd(5))}  ${c.cyan(scope.padEnd(SCOPE_WIDTH))} ` +
        `${level === 'error' ? c.red(text) : text}${details ? ' ' + details : ''}`
    ).trimEnd();
}

function write(level: Level, scope: string, message: string, fields?: Fields, err?: unknown) {
    if (LEVELS[level] < minLevel()) return;

    const all: Fields = { ...fields };
    if (err !== undefined) all.error = err instanceof Error ? err.message : String(err);
    const line = formatLine(level, scope, message, all);
    const out = level === 'error' || level === 'warn' ? console.error : console.log;
    out(line);

    // where an unexpected error came from; expected ones (a refused device) pass no Error
    if (err instanceof Error && err.stack && level === 'error') {
        const c = colors();
        const frames = err.stack
            .split('\n')
            .slice(1, 1 + STACK_FRAMES)
            .map((l) => c.gray('    ' + clean(l)));
        out(frames.join('\n'));
    }
}

export interface Logger {
    debug(message: string, fields?: Fields): void;
    info(message: string, fields?: Fields): void;
    warn(message: string, fields?: Fields, err?: unknown): void;
    error(message: string, fields?: Fields, err?: unknown): void;
}

// a logger for one part of the server: logger('device').info('connected', { device: id })
export function logger(scope: string): Logger {
    return {
        debug: (message, fields) => write('debug', scope, message, fields),
        info: (message, fields) => write('info', scope, message, fields),
        warn: (message, fields, err) => write('warn', scope, message, fields, err),
        error: (message, fields, err) => write('error', scope, message, fields, err),
    };
}
