import { Router } from 'express';
import { validationResult } from 'express-validator';
import {
    listLeads, getLeadDetail, createLead, updateLead, deleteLead,
    changeLeadStatus, assignLead, skipLead, updateLeadEmail,
} from '../controllers/leads.controller';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import {
    createLeadValidator, updateLeadValidator, changeLeadStatusValidator,
    assignLeadValidator, uuidParamValidator, leadListQueryValidator,
    skipLeadValidator, updateLeadEmailValidator,
} from '../middleware/validators';
import { BadRequestError } from '../utils/errors';

const router = Router();

const validate = (req: any, _res: any, next: any) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new BadRequestError(`Validation failed: ${errors.array().map((e) => e.msg).join(', ')}`);
    next();
};

router.use(authenticate);

router.get('/', leadListQueryValidator, validate, listLeads);
router.get('/:id', uuidParamValidator, validate, getLeadDetail);
router.post('/', authorize(['ADMIN']), createLeadValidator, validate, createLead);
router.put('/:id', authorize(['ADMIN']), uuidParamValidator, updateLeadValidator, validate, updateLead);
router.delete('/:id', authorize(['ADMIN']), uuidParamValidator, validate, deleteLead);
router.patch('/:id/status', uuidParamValidator, changeLeadStatusValidator, validate, changeLeadStatus);
router.patch('/:id/assign', authorize(['ADMIN']), uuidParamValidator, assignLeadValidator, validate, assignLead);
router.post('/:id/skip', uuidParamValidator, skipLeadValidator, validate, skipLead);
router.patch('/:id/email', uuidParamValidator, updateLeadEmailValidator, validate, updateLeadEmail);

export default router;