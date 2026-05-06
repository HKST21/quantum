import { Router } from 'express';
import {
    getBatchStatus,
    getBatchResults,
    getBatchHistory,
    getTwilioNumber,
    getUnanswered,
    retryUnanswered,
    blacklistLead,
    getAvgDuration,
} from '../controllers/batchCalls.controller';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';

const router = Router();

// Všechny endpointy vyžadují přihlášení + ADMIN roli
router.use(authenticate, authorize(['ADMIN']));

router.get('/batch-status', getBatchStatus);
router.get('/batch-results', getBatchResults);
router.get('/batch-history', getBatchHistory);
router.get('/twilio-number', getTwilioNumber);
router.get('/unanswered', getUnanswered);
router.post('/retry-unanswered', retryUnanswered);
router.get('/avg-duration', getAvgDuration);

// Blacklist je na leads routě ale dáme ho sem pro přehlednost
router.patch('/leads/:id/blacklist', blacklistLead);

export default router;