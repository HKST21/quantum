import { Request } from 'express';
import pool from '../db/pool';
import { AuditAction } from '../types';

export const logAuditAction = async (
    userId: string | null,
    action: AuditAction,
    req: Request,
    targetId?: string | null,
    details?: Record<string, any> | null
): Promise<void> => {
    try {
        const ipAddress = req.ip || req.socket.remoteAddress || null;
        const userAgent = req.get('user-agent') || null;

        await pool.query(
            `INSERT INTO audit_logs (user_id, action, target_id, ip_address, user_agent, details)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, action, targetId, ipAddress, userAgent, details ? JSON.stringify(details) : null]
        );
    } catch (error) {
        console.error('❌ Failed to log audit action:', error);
    }
};