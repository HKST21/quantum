import { Router } from 'express';
import { validationResult } from 'express-validator';
import { listUsers, createUser, deleteUser, toggleUserActivation } from '../controllers/users.controller';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { createUserValidator, uuidParamValidator } from '../middleware/validators';
import { BadRequestError } from '../utils/errors';

const router = Router();

const validate = (req: any, _res: any, next: any) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new BadRequestError(`Validation failed: ${errors.array().map((e) => e.msg).join(', ')}`);
    next();
};

router.use(authenticate, authorize(['ADMIN']));

router.get('/', listUsers);
router.post('/', createUserValidator, validate, createUser);
router.delete('/:id', uuidParamValidator, validate, deleteUser);
router.patch('/:id/activate', uuidParamValidator, validate, toggleUserActivation);

export default router;