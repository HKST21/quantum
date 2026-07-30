import { Router } from 'express';
import {
    getUnresolvedAlerts,
    resolveAlert,
    resolveAllAlerts,
    getAlertHistory,
} from '../controllers/alerts.controller';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';

const router = Router();

// Všechny endpointy vyžadují ADMIN roli
router.use(authenticate, authorize(['ADMIN']));

router.get('/unresolved', getUnresolvedAlerts);
router.get('/history', getAlertHistory);
router.post('/resolve-all', resolveAllAlerts);
router.post('/:id/resolve', resolveAlert);

export default router;