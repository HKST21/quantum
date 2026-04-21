import { Request, Response, NextFunction } from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { UserRole } from '../types';

export const authorize = (allowedRoles: UserRole[]) => {
    return (req: Request, _res: Response, next: NextFunction): void => {
        try {
            if (!req.user) {
                throw new UnauthorizedError('Not authenticated');
            }

            if (!allowedRoles.includes(req.user.role)) {
                throw new ForbiddenError('You do not have permission to access this resource');
            }

            next();
        } catch (error) {
            next(error);
        }
    };
};