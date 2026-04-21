import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { importLeads } from '../controllers/leadsImport.controller';

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

router.post('/import', authenticate, authorize(['ADMIN']), upload.single('file'), importLeads);

export default router;