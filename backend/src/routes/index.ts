import express from 'express';
import { version } from '../../../shared/version';
import { default as initAccountRoutes } from './account';
import { default as initAuthRoutes } from './auth';
import { default as initFirmwareRoutes } from './firmware';
import { default as initHealthRoutes } from './health';
import { default as initMcpRoutes } from './mcp';
import { default as initMeterRoutes } from './meters';
import { initPageRoutes } from './pages';
import { default as initStreamRoutes } from './stream';

export function initRoutes(app: express.Application) {
    app.get('/api/version', (req, res) => {
        res.json({ version });
    });

    initAuthRoutes(app);
    initAccountRoutes(app);
    initStreamRoutes(app);
    initFirmwareRoutes(app);
    initHealthRoutes(app);
    initMeterRoutes(app);
    initMcpRoutes(app);
    initPageRoutes(app);
}
