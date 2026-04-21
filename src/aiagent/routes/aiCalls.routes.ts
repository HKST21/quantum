import { Router } from 'express';
import {
    startAICalling, stopAICalling, getAICallStatus,
    getAICallLogs, getAICallLogDetail,
    getTwiML, handleStatusCallback, handleRecordingCallback,
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

export default router;