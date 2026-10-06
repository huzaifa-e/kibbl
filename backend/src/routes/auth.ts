import express from 'express';
import rateLimit from 'express-rate-limit';
import { AUTH_COOKIE, checkAuthMiddleware, generateAuthToken, passwordMatches, setAuthCookie, setPassword } from '../core/auth';
import { User } from '../core/db';
import { logger } from '../core/logger';

const log = logger('auth');

// ten wrong passwords per address in 15 minutes, then a pause
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: 'Too many failed logins. Try again in 15 minutes.',
});

export default function initAuthRoutes(app: express.Application) {
    app.post('/api/login', loginLimiter, async (req, res) => {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!email || !password || email.length > 254 || password.length > 256) {
            return res.status(400).send('E-mail and password are required.');
        }

        const user = await User.findOne({ email }).lean();
        if (!user || !(await passwordMatches(user, password))) {
            log.warn('login failed', { user: email, ip: req.ip });
            return res.status(401).send('E-mail or password is wrong.');
        }

        setAuthCookie(res, generateAuthToken(user));
        log.info('logged in', { user: email, ip: req.ip });
        res.json({ name: user.name, email: user.email });
    });

    app.post('/api/logout', (req, res) => {
        res.clearCookie(AUTH_COOKIE);
        res.sendStatus(200);
    });

    app.get('/api/loggedIn', checkAuthMiddleware, (req: RequestWithSessionInfo, res) => {
        res.json({ name: req.sessionInfo!.name, email: req.sessionInfo!.email });
    });

    app.post('/api/password', loginLimiter, checkAuthMiddleware, async (req: RequestWithSessionInfo, res) => {
        const current = typeof req.body?.current === 'string' ? req.body.current : '';
        const next = typeof req.body?.next === 'string' ? req.body.next : '';
        if (next.length < 10 || next.length > 256) {
            return res.status(400).send('The new password needs at least 10 characters.');
        }
        const user = await User.findById(req.sessionInfo!.userID);
        if (!user || !(await passwordMatches(user, current))) {
            return res.status(401).send('The current password is wrong.');
        }
        await setPassword(user, next);
        user.tokenVersion++; // every other session ends
        await user.save();
        setAuthCookie(res, generateAuthToken(user.toObject()));
        log.info('password changed', { user: user.email });
        res.sendStatus(200);
    });
}
