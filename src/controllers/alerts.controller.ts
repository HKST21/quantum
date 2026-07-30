import { Request, Response, NextFunction } from 'express';
import pool from '../db/pool';
import { BadRequestError } from '../utils/errors';

// ============================================================================
// ALERTS CONTROLLER
// ============================================================================
//
// Endpoints:
//   GET  /api/alerts/unresolved       - vrátí seznam neresolvovaných alertů
//   POST /api/alerts/:id/resolve       - označí alert jako resolvovaný
//   POST /api/alerts/resolve-all       - označí VŠECHNY jako resolvované (bulk)
//   GET  /api/alerts/history           - historie posledních 100 alertů (i resolvovaných)
// ============================================================================

/**
 * GET /api/alerts/unresolved
 * Vrátí seznam všech neresolvovaných alertů, seřazený od nejnovějšího.
 * Frontend volá každých 10s (polling).
 */
export const getUnresolvedAlerts = async (
    _req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const result = await pool.query(
            `SELECT id, type, severity, message, metadata, created_at
             FROM alerts
             WHERE resolved = false
             ORDER BY created_at DESC
             LIMIT 50`
        );

        res.status(200).json({
            success: true,
            alerts: result.rows,
            count: result.rows.length,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/alerts/:id/resolve
 * Označí konkrétní alert jako resolvovaný (Hejda klikl "OK" v notification bell).
 */
export const resolveAlert = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const { id } = req.params;

        if (!id) throw new BadRequestError('Alert ID je povinné');

        const result = await pool.query(
            `UPDATE alerts 
             SET resolved = true, 
                 resolved_at = NOW(), 
                 resolved_by = $2
             WHERE id = $1
             RETURNING id`,
            [id, req.user?.id]
        );

        if (result.rows.length === 0) {
            throw new BadRequestError(`Alert ${id} nenalezen`);
        }

        res.status(200).json({
            success: true,
            resolvedId: id,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/alerts/resolve-all
 * Označí všechny neresolvované alerty jako resolvované (bulk clear).
 */
export const resolveAllAlerts = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const result = await pool.query(
            `UPDATE alerts 
             SET resolved = true, 
                 resolved_at = NOW(), 
                 resolved_by = $1
             WHERE resolved = false
             RETURNING id`,
            [req.user?.id]
        );

        res.status(200).json({
            success: true,
            resolvedCount: result.rows.length,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/alerts/history
 * Historie posledních 100 alertů (i resolvovaných).
 */
export const getAlertHistory = async (
    _req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const result = await pool.query(
            `SELECT a.id, a.type, a.severity, a.message, a.metadata, 
                    a.resolved, a.resolved_at, a.created_at,
                    u.full_name AS resolved_by_name
             FROM alerts a
             LEFT JOIN users u ON u.id = a.resolved_by
             ORDER BY a.created_at DESC
             LIMIT 100`
        );

        res.status(200).json({
            success: true,
            alerts: result.rows,
        });
    } catch (error) {
        next(error);
    }
};