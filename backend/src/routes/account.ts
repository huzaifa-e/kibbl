import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { generateAuthToken, setAuthCookie, setPassword } from '../core/auth';
import { PasswordReset, User } from '../core/db';
import { logger } from '../core/logger';
import { appUrl, mailConfigured, sendMail } from '../core/mail';
import { escapeHtml } from '../mcp/signin';

/*
 * Accounts people make themselves: sign-up (open unless SIGNUP=closed; every account
 * sees only its own devices, meters and health), and a forgotten password reset by a
 * link sent by e-mail (core/mail.ts).
 */

const log = logger('auth');

const RESET_MS = 60 * 60_000;
const isEmail = (v: string) => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const signupOpen = () => process.env.SIGNUP !== 'closed';

const limiter = (limit: number, message: string) => rateLimit({ windowMs: 60 * 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false, message });

// five accounts and five reset mails per address an hour
const signupLimiter = limiter(5, 'Too many sign-ups from here. Try again in an hour.');
const forgotLimiter = limiter(5, 'Too many reset requests from here. Try again in an hour.');
const resetLimiter = limiter(20, 'Too many attempts. Try again in an hour.');

function readPassword(body: unknown) {
    const password = (body as { password?: unknown })?.password;
    return typeof password === 'string' && password.length >= 10 && password.length <= 256 ? password : undefined;
}

export default function initAccountRoutes(app: express.Application) {
    // what the login page offers
    app.get('/api/account/options', (_req, res) => {
        res.json({ signup: signupOpen(), reset: mailConfigured() });
    });

    app.post('/api/signup', signupLimiter, async (req, res) => {
        if (!signupOpen()) {
            res.status(403).send('New accounts are not taken on this server.');
            return;
        }
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = readPassword(req.body);
        if (!name || name.length > 60) return void res.status(400).send('Your name is needed, up to 60 characters.');
        if (!isEmail(email)) return void res.status(400).send('That is no e-mail address.');
        if (!password) return void res.status(400).send('The password needs at least 10 characters.');

        const user: User = { _id: crypto.randomUUID(), email, name, password: '', salt: '', tokenVersion: 0, createdAt: Date.now() };
        await setPassword(user, password);
        try {
            await User.create(user);
        } catch (err) {
            if ((err as { code?: number }).code === 11000) {
                res.status(409).send('There is an account with this e-mail already. Log in, or reset its password.');
                return;
            }
            throw err;
        }
        log.info('account created', { user: email, ip: req.ip });
        setAuthCookie(res, generateAuthToken(user));
        res.json({ name: user.name, email: user.email });
    });

    /* The answer is the same whether the address has an account or not: nobody learns
     * from it who uses this server. */
    app.post('/api/password/forgot', forgotLimiter, async (req, res) => {
        if (!mailConfigured()) {
            res.status(503).send('Passwords cannot be reset by e-mail on this server. Ask the person who runs it.');
            return;
        }
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (!isEmail(email)) return void res.status(400).send('That is no e-mail address.');
        res.json({ ok: true });

        const user = await User.findOne({ email }).lean();
        if (!user) {
            log.info('reset asked for an unknown address', { ip: req.ip });
            return;
        }
        const token = crypto.randomBytes(32).toString('base64url');
        await PasswordReset.deleteMany({ userID: user._id });
        await PasswordReset.create({ _id: hash(token), userID: user._id, expiresAt: new Date(Date.now() + RESET_MS) });
        const link = `${appUrl()}/reset?token=${token}`;
        const text = `Hello ${user.name},\n\nsomeone (hopefully you) asked to reset the password of your kibbl. account. Choose a new one here, within the next hour:\n\n${link}\n\nIf it was not you, ignore this mail: your password stays as it is.\n`;
        const html = `<p>Hello ${escapeHtml(user.name)},</p><p>someone (hopefully you) asked to reset the password of your kibbl. account. Choose a new one within the next hour:</p><p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#d9622b;color:#fff8ec;border:3px solid #2a1a12;border-radius:10px;font-weight:700;text-decoration:none">Choose a new password</a></p><p style="color:#7a5c47">If it was not you, ignore this mail: your password stays as it is.</p>`;
        try {
            await sendMail(user.email, 'Reset your kibbl. password', text, html);
            log.info('reset link sent', { user: user.email });
        } catch (err) {
            log.error('reset mail not sent', { user: user.email }, err);
        }
    });

    // a new password with the token of the link: every session and connector ends, this browser is logged in
    app.post('/api/password/reset', resetLimiter, async (req, res) => {
        const token = typeof req.body?.token === 'string' ? req.body.token : '';
        const password = readPassword(req.body);
        if (!password) return void res.status(400).send('The password needs at least 10 characters.');
        const reset = token ? await PasswordReset.findOneAndDelete({ _id: hash(token), expiresAt: { $gt: new Date() } }).lean() : null;
        const user = reset ? await User.findById(reset.userID) : null;
        if (!user) {
            res.status(400).send('This link is used or expired. Ask for a new one.');
            return;
        }
        await setPassword(user, password);
        user.tokenVersion++;
        await user.save();
        await PasswordReset.deleteMany({ userID: user._id });
        log.info('password reset by e-mail link', { user: user.email });
        setAuthCookie(res, generateAuthToken(user.toObject()));
        res.json({ name: user.name, email: user.email });
    });
}
