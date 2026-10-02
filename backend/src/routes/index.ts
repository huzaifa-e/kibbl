import express from 'express';
import { version } from '../../../shared/version';
import { default as initAuthRoutes } from './auth';
import { default as initFirmwareRoutes } from './firmware';
import { initPageRoutes } from './pages';
import { default as initStreamRoutes } from './stream';

export function initRoutes(app: express.Application) {
    app.get('/api/version', (req, res) => {
        res.json({ version });
    });

    initAuthRoutes(app);
    initStreamRoutes(app);
    initFirmwareRoutes(app);
    initPageRoutes(app);
}
