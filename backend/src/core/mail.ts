import nodemailer from 'nodemailer';
import { logger } from './logger';

/*
 * E-mail, for password resets: an SMTP account (SMTP_HOST, SMTP_PORT, SMTP_SECURE,
 * SMTP_USER, SMTP_PASSWORD, MAIL_FROM) and the address the app is opened at (APP_URL),
 * which the links point to. Never the address a request came with: anybody can send
 * any Host header, and a reset link must not lead anywhere else.
 */

const log = logger('mail');

let transport: ReturnType<typeof nodemailer.createTransport> | undefined;

export function appUrl() {
    return process.env.APP_URL?.replace(/\/+$/, '') || undefined;
}

export function mailConfigured() {
    return !!(process.env.SMTP_HOST && appUrl());
}

function transporter() {
    if (!transport) {
        const port = Number(process.env.SMTP_PORT) || 587;
        transport = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port,
            secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
            auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
        });
    }
    return transport;
}

export async function sendMail(to: string, subject: string, text: string, html: string) {
    const from = process.env.MAIL_FROM || process.env.SMTP_USER;
    await transporter().sendMail({ from: from ? `kibbl. <${from.replace(/^.*<|>.*$/g, '')}>` : undefined, to, subject, text, html });
    log.info('sent', { to, subject });
}
