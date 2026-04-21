import { Request, Response, NextFunction } from 'express';
import { UnauthorizedError } from '../utils/errors';
import pool, { rowToCamelCase } from '../db/pool';
import { User } from '../types';

export const authenticate = async (
    req: Request,
    _res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        if (!req.session || !req.session.userId) {
            throw new UnauthorizedError('Not authenticated');
        }

        if (!req.session.twoFactorVerified) {
            throw new UnauthorizedError('Two-factor authentication required');
        }

        const result = await pool.query(
            `SELECT id, email, full_name, role, is_active FROM users WHERE id = $1`,
            [req.session.userId]
        );

        if (result.rows.length === 0) {
            throw new UnauthorizedError('User not found');
        }

        const user = rowToCamelCase<User>(result.rows[0]);

        if (!user.isActive) {
            throw new UnauthorizedError('Account is deactivated');
        }

        req.user = {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            role: user.role,
        };

        next();
    } catch (error) {
        next(error);
    }
};