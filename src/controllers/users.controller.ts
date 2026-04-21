import { Request, Response, NextFunction } from 'express';
import pool, { rowToCamelCase, rowsToCamelCase } from '../db/pool';
import { hashPassword, validatePasswordStrength } from '../utils/bcrypt';
import { logAuditAction } from '../middleware/auditLog';
import { BadRequestError, NotFoundError, ConflictError } from '../utils/errors';
import { CreateUserRequest, UserResponse } from '../types';

export const listUsers = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const result = await pool.query(
            `SELECT id, email, full_name, role, is_active, last_login, created_at
             FROM users ORDER BY created_at DESC`
        );
        const users = rowsToCamelCase<UserResponse>(result.rows);
        res.status(200).json({ users });
    } catch (error) {
        next(error);
    }
};

export const createUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { email, password, fullName, role } = req.body as CreateUserRequest;

        const passwordValidation = validatePasswordStrength(password);
        if (!passwordValidation.valid) {
            throw new BadRequestError(`Password validation failed: ${passwordValidation.errors.join(', ')}`);
        }

        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existingUser.rows.length > 0) throw new ConflictError('User with this email already exists');

        const passwordHash = await hashPassword(password);

        const result = await pool.query(
            `INSERT INTO users (email, password_hash, full_name, role)
             VALUES ($1, $2, $3, $4)
             RETURNING id, email, full_name, role, is_active, created_at`,
            [email.toLowerCase(), passwordHash, fullName, role]
        );

        const newUser = rowToCamelCase<UserResponse>(result.rows[0]);
        await logAuditAction(req.user!.id, 'USER_CREATED', req, newUser.id, { email: newUser.email, role: newUser.role });

        res.status(201).json({ user: newUser, message: 'User created successfully. They must set up 2FA on first login.' });
    } catch (error) {
        next(error);
    }
};

export const deleteUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        if (id === req.user!.id) throw new BadRequestError('You cannot delete your own account');

        const userResult = await pool.query('SELECT id, email, full_name FROM users WHERE id = $1', [id]);
        if (userResult.rows.length === 0) throw new NotFoundError('User not found');

        const user = userResult.rows[0];
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
        await logAuditAction(req.user!.id, 'USER_DELETED', req, id, { email: user.email });

        res.status(200).json({ message: 'User deleted successfully' });
    } catch (error) {
        next(error);
    }
};

export const toggleUserActivation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const { isActive } = req.body as { isActive: boolean };

        if (typeof isActive !== 'boolean') throw new BadRequestError('isActive must be a boolean');
        if (id === req.user!.id) throw new BadRequestError('You cannot deactivate your own account');

        const userResult = await pool.query('SELECT id, email FROM users WHERE id = $1', [id]);
        if (userResult.rows.length === 0) throw new NotFoundError('User not found');

        await pool.query('UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2', [isActive, id]);
        await logAuditAction(req.user!.id, isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', req, id);

        res.status(200).json({ message: `User ${isActive ? 'activated' : 'deactivated'} successfully` });
    } catch (error) {
        next(error);
    }
};