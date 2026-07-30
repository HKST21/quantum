import { Router } from 'express';
import {
    startAICalling, stopAICalling, getAICallStatus,
    getAICallLogs, getAICallLogDetail,
    getTwiML, handleStatusCallback, handleRecordingCallback,
    startOdorikTestCall, startOdorikCalling, getOdorikConfig
} from '../controllers/aiCalls.controller';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';

const router = Router();

// Admin routes
router.post('/start', authenticate, authorize(['ADMIN']), startAICalling);
router.post('/stop', authenticate, authorize(['ADMIN']), stopAICalling);
router.get('/status', authenticate, authorize(['ADMIN']), getAICallStatus);
router.get('/logs', authenticate, authorize(['ADMIN']), getAICallLogs);
router.get('/logs/:id', authenticate, authorize(['ADMIN']), getAICallLogDetail);

// Twilio webhooks (public)
router.post('/webhook/twiml', getTwiML);
router.post('/webhook/status-callback', handleStatusCallback);
router.post('/webhook/recording-callback', handleRecordingCallback);

router.post('/test-odorik', authenticate, authorize(['ADMIN']), startOdorikTestCall);

// Odorik konfigurace pro frontend (aktivní SIP jména + maxWorkers)
router.get('/odorik-config', authenticate, authorize(['ADMIN']), getOdorikConfig);

// PRODUKČNÍ Odorik paralelní volání
router.post('/start-odorik-calling', authenticate, authorize(['ADMIN']), startOdorikCalling);

export default router;