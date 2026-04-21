import { Router } from 'express';
import { validationResult } from 'express-validator';
import { getInvoiceData, createOrUpdateInvoiceData, deleteTariff } from '../controllers/invoiceData.controller';
import { authenticate } from '../middleware/authenticate';
import { invoiceDataValidator, uuidParamValidator } from '../middleware/validators';
import { BadRequestError } from '../utils/errors';

const router = Router();

const validate = (req: any, _res: any, next: any) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new BadRequestError(`Validation failed: ${errors.array().map((e) => e.msg).join(', ')}`);
    next();
};

router.use(authenticate);

router.get('/:id/invoice', uuidParamValidator, validate, getInvoiceData);
router.post('/:id/invoice', uuidParamValidator, invoiceDataValidator, validate, createOrUpdateInvoiceData);
router.put('/:id/invoice', uuidParamValidator, invoiceDataValidator, validate, createOrUpdateInvoiceData);
router.delete('/:id/invoice/tariffs/:tariffId', uuidParamValidator, validate, deleteTariff);

export default router;