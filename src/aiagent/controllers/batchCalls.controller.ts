import { Request, Response, NextFunction } from 'express';
import pool from '../../db/pool';

const AI_AGENT_ID = '53c65ca7-68bc-4948-83e5-35a64c17f0fb';

// ============================================
// GET /api/ai-calls/batch-status
// Progress aktuální dávky + live volané číslo
// ============================================
export const getBatchStatus = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        // Aktuálně volaný lead
        const currentResult = await pool.query(
            `SELECT l.phone, l.company_name
             FROM leads l
             WHERE l.ai_call_status = 'calling'
             AND l.assigned_to = $1
             LIMIT 1`,
            [AI_AGENT_ID]
        );

        // Statistiky dnešního dne
        const statsResult = await pool.query(
            `SELECT
                COUNT(*) FILTER (WHERE acl.status = 'completed') AS completed,
                COUNT(*) FILTER (WHERE acl.outcome = 'CHCE_KONTAKT_AI') AS interested,
                COUNT(*) FILTER (WHERE acl.outcome = 'NEZVEDL_TELEFON') AS no_answer,
                COUNT(*) FILTER (WHERE acl.outcome = 'NEKONTAKTOVAT') AS rejected,
                COUNT(*) FILTER (WHERE acl.outcome = 'ODKLADA') AS callback,
                ROUND(AVG(acl.duration) FILTER (WHERE acl.duration IS NOT NULL AND acl.duration > 0)) AS avg_duration
             FROM ai_call_logs acl
             WHERE DATE(acl.created_at AT TIME ZONE 'Europe/Prague') = CURRENT_DATE`,
        );

        // Počet NOVY leadů čekajících ve frontě
        const queueResult = await pool.query(
            `SELECT COUNT(*) AS queue_size
             FROM leads
             WHERE status = 'NOVY'
             AND assigned_to = $1
             AND (ai_call_status IS NULL OR ai_call_status = 'failed')`,
            [AI_AGENT_ID]
        );

        const isRunning = currentResult.rows.length > 0;
        const stats = statsResult.rows[0];
        const queueSize = parseInt(queueResult.rows[0].queue_size);

        res.status(200).json({
            isRunning,
            currentCall: isRunning ? {
                phone: currentResult.rows[0].phone,
                companyName: currentResult.rows[0].company_name,
            } : null,
            today: {
                completed: parseInt(stats.completed || 0),
                interested: parseInt(stats.interested || 0),
                noAnswer: parseInt(stats.no_answer || 0),
                rejected: parseInt(stats.rejected || 0),
                callback: parseInt(stats.callback || 0),
                avgDuration: parseInt(stats.avg_duration || 0),
                conversionRate: stats.completed > 0
                    ? Math.round((stats.interested / stats.completed) * 100)
                    : 0,
            },
            queueSize,
        });
    } catch (error) {
        next(error);
    }
};

// ============================================
// GET /api/ai-calls/batch-results?date=YYYY-MM-DD
// Výsledky dávky pro daný den — CHCE_KONTAKT_AI leady
// ============================================
export const getBatchResults = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const date = req.query.date as string || new Date().toISOString().split('T')[0];

        const result = await pool.query(
            `SELECT
                l.phone                                                         AS telefon,
                COALESCE(l.contact_person, '')                                  AS jmeno,
                COALESCE(l.company_name, '')                                    AS firma,
                acl.ai_notes                                                    AS poznamka_evy,
                acl.recording_url                                               AS nahravka,
                acl.duration                                                    AS delka_sec,
                TO_CHAR(acl.created_at AT TIME ZONE 'Europe/Prague',
                        'DD.MM.YYYY HH24:MI')                                   AS datum_hovoru
             FROM ai_call_logs acl
             JOIN leads l ON acl.lead_id = l.id
             WHERE acl.outcome = 'CHCE_KONTAKT_AI'
             AND DATE(acl.created_at AT TIME ZONE 'Europe/Prague') = $1
             ORDER BY acl.created_at DESC`,
            [date]
        );

        res.status(200).json({
            date,
            leads: result.rows,
            total: result.rows.length,
        });
    } catch (error) {
        next(error);
    }
};

// ============================================
// GET /api/ai-calls/batch-history
// Seznam dní se statistikami — posledních 30 dní
// ============================================
export const getBatchHistory = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const result = await pool.query(
            `SELECT
                DATE(acl.created_at AT TIME ZONE 'Europe/Prague')               AS datum,
                COUNT(*)                                                         AS celkem_hovoru,
                COUNT(*) FILTER (WHERE acl.status = 'completed')                AS completed,
                COUNT(*) FILTER (WHERE acl.outcome = 'CHCE_KONTAKT_AI')         AS interested,
                COUNT(*) FILTER (WHERE acl.outcome = 'NEZVEDL_TELEFON')         AS no_answer,
                COUNT(*) FILTER (WHERE acl.outcome = 'NEKONTAKTOVAT')           AS rejected,
                COUNT(*) FILTER (WHERE acl.outcome = 'ODKLADA')                 AS callback,
                ROUND(AVG(acl.duration) FILTER (WHERE acl.duration IS NOT NULL AND acl.duration > 0)) AS avg_duration,
                ROUND(
                    COUNT(*) FILTER (WHERE acl.outcome = 'CHCE_KONTAKT_AI')::numeric /
                    NULLIF(COUNT(*) FILTER (WHERE acl.status = 'completed'), 0) * 100
                )                                                                AS conversion_rate
             FROM ai_call_logs acl
             WHERE acl.created_at >= NOW() - INTERVAL '30 days'
             GROUP BY DATE(acl.created_at AT TIME ZONE 'Europe/Prague')
             ORDER BY datum DESC`
        );

        res.status(200).json({
            batches: result.rows.map(row => ({
                datum: row.datum,
                celkemHovoru: parseInt(row.celkem_hovoru),
                completed: parseInt(row.completed),
                interested: parseInt(row.interested),
                noAnswer: parseInt(row.no_answer),
                rejected: parseInt(row.rejected),
                callback: parseInt(row.callback),
                avgDuration: parseInt(row.avg_duration || 0),
                conversionRate: parseInt(row.conversion_rate || 0),
            })),
        });
    } catch (error) {
        next(error);
    }
};

// ============================================
// GET /api/ai-calls/twilio-number
// Vrátí telefonní číslo Evy z env
// ============================================
export const getTwilioNumber = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const phone = process.env.TWILIO_PHONE_NUMBER || 'Není nakonfigurováno';
        res.status(200).json({ phone });
    } catch (error) {
        next(error);
    }
};

// ============================================
// GET /api/ai-calls/unanswered
// Bulletproof select — reálně nedovolané (bez nahrávky, max 3 pokusy)
// ============================================
export const getUnanswered = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const result = await pool.query(
            `SELECT
                l.id,
                l.phone,
                COALESCE(l.company_name, '')    AS company_name,
                l.status,
                COUNT(acl.id)                   AS total_attempts,
                COUNT(acl.recording_url) FILTER (
                    WHERE acl.recording_url IS NOT NULL AND acl.recording_url != ''
                )                               AS attempts_with_recording
             FROM leads l
             LEFT JOIN ai_call_logs acl ON l.id = acl.lead_id
             WHERE
                l.status = 'NEZVEDL_TELEFON'
                AND l.assigned_to = $1
             GROUP BY l.id, l.phone, l.company_name, l.status
             HAVING
                COUNT(acl.recording_url) FILTER (
                    WHERE acl.recording_url IS NOT NULL AND acl.recording_url != ''
                ) = 0
                AND COUNT(acl.id) < 3
             ORDER BY l.updated_at DESC`,
            [AI_AGENT_ID]
        );

        res.status(200).json({
            leads: result.rows.map(row => ({
                id: row.id,
                phone: row.phone,
                companyName: row.company_name,
                status: row.status,
                totalAttempts: parseInt(row.total_attempts),
                attemptsWithRecording: parseInt(row.attempts_with_recording),
            })),
            total: result.rows.length,
        });
    } catch (error) {
        next(error);
    }
};

// ============================================
// POST /api/ai-calls/retry-unanswered
// Reset nedovolaných na NOVY — ochrana max 3 pokusy přes ai_call_logs
// ============================================
export const retryUnanswered = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        // Nejdřív ověříme kolik jich je eligible (bulletproof podmínka + max 3 pokusy)
        const eligibleResult = await pool.query(
            `SELECT l.id
             FROM leads l
             LEFT JOIN ai_call_logs acl ON l.id = acl.lead_id
             WHERE
                l.status = 'NEZVEDL_TELEFON'
                AND l.assigned_to = $1
             GROUP BY l.id
             HAVING
                COUNT(acl.recording_url) FILTER (
                    WHERE acl.recording_url IS NOT NULL AND acl.recording_url != ''
                ) = 0
                AND COUNT(acl.id) < 3`,
            [AI_AGENT_ID]
        );

        const eligibleIds = eligibleResult.rows.map(r => r.id);

        if (eligibleIds.length === 0) {
            res.status(200).json({ updated: 0, message: 'Žádné leady k opakování' });
            return;
        }

        // UPDATE — zachovává původní SQL, ai_call_attempts resetujeme (ochrana je přes ai_call_logs)
        const updateResult = await pool.query(
            `UPDATE leads
             SET
                status = 'NOVY',
                ai_call_attempts = 0,
                ai_call_status = NULL,
                updated_at = NOW()
             WHERE id = ANY($1)
             RETURNING id`,
            [eligibleIds]
        );

        res.status(200).json({
            updated: updateResult.rows.length,
            message: `${updateResult.rows.length} leadů zařazeno zpět do fronty`,
        });
    } catch (error) {
        next(error);
    }
};

// ============================================
// PATCH /api/leads/:id/blacklist
// Nastaví lead na NEKONTAKTOVAT
// ============================================
export const blacklistLead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;

        const leadResult = await pool.query(
            `SELECT id, phone, status FROM leads WHERE id = $1`,
            [id]
        );

        if (leadResult.rows.length === 0) {
            res.status(404).json({ error: { message: 'Lead nenalezen', statusCode: 404 } });
            return;
        }

        const lead = leadResult.rows[0];
        const oldStatus = lead.status;

        await pool.query(
            `UPDATE leads SET status = 'NEKONTAKTOVAT', updated_at = NOW() WHERE id = $1`,
            [id]
        );

        await pool.query(
            `INSERT INTO lead_comments (lead_id, user_id, old_status, new_status, comment)
             VALUES ($1, $2, $3, 'NEKONTAKTOVAT', '🚫 Přidáno na blacklist přes CRM')`,
            [id, req.user?.id || AI_AGENT_ID, oldStatus]
        );

        res.status(200).json({
            message: 'Lead přidán na blacklist',
            phone: lead.phone,
        });
    } catch (error) {
        next(error);
    }
};

// ============================================
// GET /api/ai-calls/avg-duration
// Průměrná délka hovoru z posledních 100 hovorů pro odhad času dávky
// ============================================
export const getAvgDuration = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const result = await pool.query(
            `SELECT
                ROUND(AVG(duration))    AS avg_duration,
                COUNT(*)                AS sample_size
             FROM (
                 SELECT duration
                 FROM ai_call_logs
                 WHERE duration IS NOT NULL
                 AND duration > 0
                 AND status = 'completed'
                 ORDER BY created_at DESC
                 LIMIT 100
             ) recent`
        );

        const avgDuration = parseInt(result.rows[0].avg_duration || 30); // fallback 30s
        const sampleSize = parseInt(result.rows[0].sample_size || 0);
        const overhead = 8; // Twilio setup overhead v sekundách

        res.status(200).json({
            avgDuration,
            overhead,
            totalPerCall: avgDuration + overhead,
            sampleSize,
        });
    } catch (error) {
        next(error);
    }
};