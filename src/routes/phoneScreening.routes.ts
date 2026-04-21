import { Router } from 'express';
import { validationResult } from 'express-validator';
import { getPhoneScreening, createOrUpdatePhoneScreening } from '../controllers/phoneScreening.controller';
import { authenticate } from '../middleware/authenticate';
import { phoneScreeningValidator, uuidParamValidator } from '../middleware/validators';
import { BadRequestError } from '../utils/errors';

const router = Router();

const validate = (req: any, _res: any, next: any) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new BadRequestError(`Validation failed: ${errors.array().map((e) => e.msg).join(', ')}`);
    next();
};

router.use(authenticate);

router.get('/:id/screening', uuidParamValidator, validate, getPhoneScreening);
router.post('/:id/screening', uuidParamValidator, phoneScreeningValidator, validate, createOrUpdatePhoneScreening);
router.put('/:id/screening', uuidParamValidator, phoneScreeningValidator, validate, createOrUpdatePhoneScreening);

export default router;