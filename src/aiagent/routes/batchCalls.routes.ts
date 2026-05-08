import { Router } from 'express';
import multer from 'multer';
import {
    getBatchStatus,
    getBatchResults,
    getBatchHistory,
    getTwilioNumber,
    getUnanswered,
    retryUnanswered,
    blacklistLead,
    getAvgDuration,
    importLeads,
    verifyPassword,
    reassignLeads,
} from '../controllers/batchCalls.controller';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';

const router = Router();

const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (_req, file, cb) => {
        const allowed = [
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel.sheet.macroEnabled.12',
        ];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Pouze Excel soubory jsou povoleny'));
    },
    limits: { fileSize: 50 * 1024 * 1024 },
});

router.use(authenticate, authorize(['ADMIN']));

router.get('/batch-status', getBatchStatus);
router.get('/batch-results', getBatchResults);
router.get('/batch-history', getBatchHistory);
router.get('/twilio-number', getTwilioNumber);
router.get('/unanswered', getUnanswered);
router.post('/retry-unanswered', retryUnanswered);
router.get('/avg-duration', getAvgDuration);
router.post('/import-leads', upload.single('file'), importLeads);
router.post('/verify-password', verifyPassword);
router.post('/reassign-leads', reassignLeads);

router.patch('/leads/:id/blacklist', blacklistLead);

export default router;