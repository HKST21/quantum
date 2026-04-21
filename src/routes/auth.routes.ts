import { Router } from 'express';
import { validationResult } from 'express-validator';
import { login, verifyTwoFactor, logout, getCurrentUser, setupTwoFactorAuth } from '../controllers/auth.controller';
import { authenticate } from '../middleware/authenticate';
import { loginValidator, verifyTwoFactorValidator } from '../middleware/validators';
import { BadRequestError } from '../utils/errors';

const router = Router();

const validate = (req: any, _res: any, next: any) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new BadRequestError(`Validation failed: ${errors.array().map((e) => e.msg).join(', ')}`);
    next();
};

router.post('/login', loginValidator, validate, login);
router.post('/verify-2fa', verifyTwoFactorValidator, validate, verifyTwoFactor);
router.post('/logout', logout);
router.get('/me', authenticate, getCurrentUser);
router.get('/setup-2fa', authenticate, setupTwoFactorAuth);

export default router;