import { Request, Response, NextFunction } from 'express';
import pool, { rowToCamelCase } from '../db/pool';
import { comparePassword } from '../utils/bcrypt';
import { verifyTotpToken, setupTwoFactor } from '../utils/totp';
import { logAuditAction } from '../middleware/auditLog';
import { BadRequestError, UnauthorizedError, TooManyRequestsError } from '../utils/errors';
import { User, LoginRequest, VerifyTwoFactorRequest } from '../types';

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { email, password } = req.body as LoginRequest;

        const result = await pool.query(
            `SELECT id, email, password_hash, full_name, role, totp_secret, is_active,
                    failed_login_attempts, locked_until, last_login
             FROM users WHERE email = $1`,
            [email.toLowerCase()]
        );

        if (result.rows.length === 0) {
            await logAuditAction(null, 'LOGIN_FAILED', req, null, { email });
            throw new UnauthorizedError('Invalid email or password');
        }

        const user = rowToCamelCase<User>(result.rows[0]);

        if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
            const minutesLeft = Math.ceil((new Date(user.lockedUntil).getTime() - Date.now()) / 60000);
            throw new TooManyRequestsError(`Account is locked. Try again in ${minutesLeft} minutes.`);
        }

        if (!user.isActive) {
            throw new UnauthorizedError('Account is deactivated');
        }

        const isPasswordValid = await comparePassword(password, user.passwordHash);

        if (!isPasswordValid) {
            const newFailedAttempts = user.failedLoginAttempts + 1;
            const lockUntil = newFailedAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;

            await pool.query(
                `UPDATE users SET failed_login_attempts = $1, locked_until = $2, updated_at = NOW() WHERE id = $3`,
                [newFailedAttempts, lockUntil, user.id]
            );

            await logAuditAction(user.id, 'LOGIN_FAILED', req, null, { attempts: newFailedAttempts });
            throw new UnauthorizedError('Invalid email or password');
        }

        if (!user.totpSecret) {
            throw new BadRequestError('Two-factor authentication is not set up. Please contact administrator.');
        }

        req.session.userId = user.id;
        req.session.email = user.email;
        req.session.role = user.role;
        req.session.twoFactorVerified = false;

        res.status(200).json({
            requiresTwoFactor: true,
            message: 'Please enter your two-factor authentication code',
        });
    } catch (error) {
        next(error);
    }
};

export const verifyTwoFactor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { email, token } = req.body as VerifyTwoFactorRequest;

        const result = await pool.query(
            `SELECT id, email, full_name, role, totp_secret, is_active FROM users WHERE email = $1`,
            [email.toLowerCase()]
        );

        if (result.rows.length === 0) throw new UnauthorizedError('Invalid credentials');

        const user = rowToCamelCase<User>(result.rows[0]);

        if (!user.isActive) throw new UnauthorizedError('Account is deactivated');
        if (!user.totpSecret) throw new BadRequestError('Two-factor authentication is not set up');

        const isTokenValid = verifyTotpToken(token, user.totpSecret);

        if (!isTokenValid) {
            await logAuditAction(user.id, 'LOGIN_FAILED', req, null, { reason: '2fa_invalid' });
            throw new UnauthorizedError('Invalid two-factor authentication code');
        }

        await pool.query(
            `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW(), updated_at = NOW() WHERE id = $1`,
            [user.id]
        );

        req.session.userId = user.id;
        req.session.email = user.email;
        req.session.role = user.role;
        req.session.twoFactorVerified = true;

        await logAuditAction(user.id, 'LOGIN_SUCCESS', req);

        res.status(200).json({
            success: true,
            user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
        });
    } catch (error) {
        next(error);
    }
};

export const logout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const userId = req.session?.userId;
        if (userId) await logAuditAction(userId, 'LOGOUT', req);

        req.session.destroy((err) => {
            if (err) console.error('Session destroy error:', err);
        });

        res.status(200).json({ message: 'Logged out successfully' });
    } catch (error) {
        next(error);
    }
};

export const getCurrentUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!req.user) throw new UnauthorizedError('Not authenticated');
        res.status(200).json({ user: req.user });
    } catch (error) {
        next(error);
    }
};

export const setupTwoFactorAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!req.user) throw new UnauthorizedError('Not authenticated');

        const result = await pool.query('SELECT totp_secret FROM users WHERE id = $1', [req.user.id]);
        if (result.rows.length === 0) throw new UnauthorizedError('User not found');
        if (result.rows[0].totp_secret) throw new BadRequestError('Two-factor authentication is already set up');

        const { secret, qrCode, manual } = await setupTwoFactor(req.user.email);

        await pool.query('UPDATE users SET totp_secret = $1, updated_at = NOW() WHERE id = $2', [secret, req.user.id]);

        res.status(200).json({ qrCode, secret, manual });
    } catch (error) {
        next(error);
    }
};