/* eslint-disable security-node/detect-crlf */
import chalk from 'chalk';
export const isDev = () => process.env.NODE_ENV !== 'production';

// Extract file path and line number from stack trace
function getCallerLocation(): string {
    const stack = new Error().stack;
    if (!stack) return '';

    const callerLine = stack.split('\n')[3];
    if (!callerLine) return '';

    // Format: "    at functionName (file:line:col)" or "    at file:line:col"
    const match = callerLine.match(/\(([^)]+)\)|at\s+(.+)/);
    const location = match ? match[1] || match[2] : '';
    if (!location) return '';

    // Extract just filename and line number
    const pathMatch = location.match(/([^/\\]+):(\d+):\d+$/);
    return pathMatch ? `${pathMatch[1]}:${pathMatch[2]}` : '';
}

export function log(level: 'debug' | 'info' | 'warn' | 'error', content: string | object) {
    let txt: string;
    if (typeof content === 'string') {
        txt = content;
    } else {
        try {
            txt = JSON.stringify(content);
        } catch (error) {
            txt = String(content);
        }
    }

    // Remove newline characters to protect against crlf injection
    txt = txt.replace(/(\r\n|\n|\r)/gm, '');

    const dateStr = new Date().toISOString();
    const location = getCallerLocation();
    const locationStr = location ? chalk.cyan(`[${location}]`) : '';

    if (level === 'error') {
        console.error(`${dateStr} - ${chalk.bgRed('ERROR')}: ${locationStr} ${chalk.red(txt)}`);
    } else if (level === 'warn') {
        console.warn(`${dateStr} - ${chalk.yellow('WARN')}: ${locationStr} ${txt}`);
    } else if (level === 'info') {
        console.info(`${dateStr} - ${chalk.blue('INFO')}: ${locationStr} ${txt}`);
    } else if (isDev()) {
        console.log(`${dateStr} - ${locationStr} ${chalk.gray(`DEBUG: ${txt}`)}`);
    }
}
