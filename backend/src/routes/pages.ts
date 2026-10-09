import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AUTH_COOKIE, checkAuthToken } from '../core/auth';

const pages = [
    { name: 'index', path: '', auth: true },
    { name: 'login', path: 'login', auth: false },
    { name: 'signup', path: 'signup', auth: false },
    { name: 'forgot', path: 'forgot', auth: false },
    { name: 'reset', path: 'reset', auth: false },
    { name: 'camera', path: 'camera/:deviceID', auth: true },
    { name: 'activity', path: 'activity', auth: true },
    { name: 'health', path: 'health', auth: true },
    { name: 'meter', path: 'meter/:meterID', auth: true },
    { name: 'heat', path: 'heat', auth: true },
    { name: 'rooms', path: 'rooms', auth: true },
    { name: 'rooms', path: 'rooms/:roomID', auth: true },
    { name: 'air', path: 'air', auth: true },
    { name: 'air', path: 'air/:deviceID', auth: true },
    { name: 'devices', path: 'devices', auth: true },
    { name: 'settings', path: 'settings', auth: true },

    { name: '404', path: '404', auth: false },
];

const pageCache = new Map<string, string>();

export function sendPage(res: express.Response, pageName: string) {
    let page = pageCache.get(pageName);
    if (!page) {
        if (!pages.find((p) => p.name === pageName)) {
            sendPage(res, '404');
            return;
        }
        try {
            page = readFileSync(path.resolve(__dirname, 'frontend', `${pageName}.html`), 'utf-8');
            if (process.env.NODE_ENV === 'production') {
                pageCache.set(pageName, page);
            }
        } catch (e) {
            res.status(500).send('Internal Server Error');
            return;
        }
    }
    res.header('Content-Type', 'text/html');
    res.header('Cache-Control', 'private, no-cache');
    if (pageName === '404') {
        res.status(404);
    }
    res.send(page);
}

export function initPageRoutes(app: express.Application) {
    for (const page of pages) {
        app.get(`/${page.path}`, async (req, res) => {
            if (page.auth && !(await checkAuthToken(req.cookies?.[AUTH_COOKIE]))) {
                res.redirect(302, '/login');
                return;
            }
            sendPage(res, page.name);
        });
        app.get(`/${page.path}.html`, (req, res) => {
            res.redirect(302, `/${page.path}`);
        });
    }

    app.get('/index.html', (req, res) => {
        res.redirect(302, '/');
    });
}
