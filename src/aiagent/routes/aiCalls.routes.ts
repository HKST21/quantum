import { Router } from 'express';
import {
    startAICalling, stopAICalling, getAICallStatus,
    getAICallLogs, getAICallLogDetail,
    getTwiML, handleStatusCallback, handleRecordingCallback,
    startOdorikTestCall, getOdorikConfig
} from '../controllers/aiCalls.controller';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';

const router = Router();

// ⚠️ SJEDNOCENO — /start teď přijímá i provider ('twilio'|'odorik') a
// engine ('openai'|'gemini') v body. Starý /start-odorik-calling byl
// odstraněn.
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

router.get('/odorik-config', authenticate, authorize(['ADMIN']), getOdorikConfig);

export default router;