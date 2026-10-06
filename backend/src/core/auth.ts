import { sign as signJWT, verify as verifyJWT } from 'jsonwebtoken';
import crypto from 'node:crypto';
import express from 'express';
import { User } from './db';
import { logger } from './logger';

const log = logger('auth');

export const AUTH_COOKIE = 'auth';
const TOKEN_LIFETIME_S = 30 * 24 * 3600;

function jwtSecret() {
    return process.env.JWT_SECRET as string;
}

export function generatePasswordHash(password: string, salt: string) {
    return new Promise<string>((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (err, key) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(key.toString('hex'));
        });
    });
}

export async function passwordMatches(user: User, password: string) {
    const hash = Buffer.from(await generatePasswordHash(password, user.salt), 'hex');
    const stored = Buffer.from(user.password, 'hex');
    return hash.length === stored.length && crypto.timingSafeEqual(hash, stored);
}

export async function setPassword(user: User, password: string) {
    user.salt = crypto.randomBytes(16).toString('hex');
    user.password = await generatePasswordHash(password, user.salt);
}

export function generateAuthToken(user: User) {
    const sessionInfo: SessionInfo = { userID: user._id, email: user.email, name: user.name, tokenVersion: user.tokenVersion };
    return signJWT(sessionInfo, jwtSecret(), { expiresIn: TOKEN_LIFETIME_S, algorithm: 'HS512', notBefore: '-5s' });
}

export function setAuthCookie(res: express.Response, token: string) {
    res.cookie(AUTH_COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
        // behind the https tunnel or proxy; a plain http LAN deployment cannot set it
        secure: process.env.COOKIE_SECURE === 'true',
        maxAge: TOKEN_LIFETIME_S * 1000,
    });
}

/* Valid signature and lifetime are not enough: the user must still exist with the
 * token version it had, so a password change logs out every other session. */
export async function checkAuthToken(token: string | undefined): Promise<SessionInfo | undefined> {
    if (typeof token !== 'string' || token.length === 0) {
        return undefined;
    }
    let session: SessionInfo;
    try {
        session = verifyJWT(token, jwtSecret(), { algorithms: ['HS512'] }) as SessionInfo;
    } catch {
        return undefined;
    }
    const user = await User.findById(session.userID).lean();
    if (!user || user.tokenVersion !== session.tokenVersion) {
        return undefined;
    }
    return session;
}

export function readCookie(header: string | undefined, name: string) {
    if (!header) {
        return undefined;
    }
    for (const part of header.split(';')) {
        const [key, ...value] = part.trim().split('=');
        if (key === name) {
            return decodeURIComponent(value.join('='));
        }
    }
    return undefined;
}

export async function checkAuthMiddleware(req: RequestWithSessionInfo, res: express.Response, next: express.NextFunction) {
    const session = await checkAuthToken(req.cookies?.[AUTH_COOKIE]);
    if (!session) {
        res.status(401).send('Unauthorized');
        return;
    }
    req.sessionInfo = session;
    next();
}

// the first start creates the account named in the environment; later starts leave the users alone
export async function ensureAdminUser() {
    if ((await User.countDocuments()) > 0) {
        return;
    }
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) {
        log.warn('no user yet, set ADMIN_EMAIL and ADMIN_PASSWORD to create the first one');
        return;
    }
    const user: User = {
        _id: crypto.randomUUID(),
        email,
        name: process.env.ADMIN_NAME || email.split('@')[0],
        password: '',
        salt: '',
        tokenVersion: 0,
        createdAt: Date.now(),
    };
    await setPassword(user, password);
    await User.create(user);
    log.info('user created', { user: email });
}
