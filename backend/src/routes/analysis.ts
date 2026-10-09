import express from 'express';
import { analysis } from '../analysis/service';
import { checkAuthMiddleware } from '../core/auth';

/* Everything the home's data says now, from all its parts (analysis/service.ts); ?fresh=1
 * analyses again instead of the report of the last 2 minutes. */
export default function initAnalysisRoutes(app: express.Application) {
    app.get('/api/analysis', checkAuthMiddleware as express.RequestHandler, async (req: RequestWithSessionInfo, res) => {
        res.json(await analysis(req.sessionInfo!.userID, req.query.fresh === '1'));
    });
}
