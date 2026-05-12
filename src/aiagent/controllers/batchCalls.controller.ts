import { Request, Response, NextFunction } from 'express';
import pool from '../../db/pool';
import bcrypt from 'bcrypt';

const DEFAULT_AI_AGENT_ID = '53c65ca7-68bc-4948-83e5-35a64c17f0fb';

const getAgentId = (req: Request): string =>
    (req.query.agentUserId as string) || DEFAULT_AI_AGENT_ID;

// ============================================
// POST /api/ai-calls/verify-password
// ============================================
export const verifyPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { password } = req.body;
        if (!password) {
            res.status(400).json({ error: { message: 'Heslo je povinné', statusCode: 400 } });
            return;
        }
        const result = await pool.query(
            `SELECT password_hash FROM users WHERE id = $1 AND is_active = true`,
            [req.user!.id]
        );
        if (result.rows.length === 0) {
            res.status(401).json({ error: { message: 'Uživatel nenalezen', statusCode: 401 } });
            return;
        }
        const isValid = await bcrypt.compare(password, result.rows[0].password_hash);
        if (!isValid) {
            res.status(401).json({ error: { message: 'Nesprávné heslo', statusCode: 401 } });
            return;
        }
        res.status(200).json({ success: true });
    } catch (error) {
        next(error);
    }
};

// ============================================
// GET /api/ai-calls/batch-status?agentUserId=
// ============================================
export const getBatchStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const agentId = getAgentId(req);

        const currentResult = await pool.query(
            `SELECT l.phone, l.company_name
             FROM leads l
             WHERE l.ai_call_status = 'calling'
             AND l.assigned_to = $1
             LIMIT 1`,
            [agentId]
        );

        const statsResult = await pool.query(
            `SELECT
                COUNT(*) FILTER (WHERE acl.status = 'completed') AS completed,
                COUNT(*) FILTER (WHERE acl.outcome = 'CHCE_KONTAKT_AI') AS interested,
                COUNT(*) FILTER (WHERE acl.outcome = 'NEZVEDL_TELEFON') AS no_answer,
                COUNT(*) FILTER (WHERE acl.outcome = 'NEKONTAKTOVAT') AS rejected,
                COUNT(*) FILTER (WHERE acl.outcome = 'ODKLADA') AS callback,
                ROUND(AVG(acl.duration) FILTER (WHERE acl.duration IS NOT NULL AND acl.duration > 0)) AS avg_duration
             FROM ai_call_logs acl
             JOIN leads l ON acl.lead_id = l.id
             WHERE DATE(acl.created_at AT TIME ZONE 'Europe/Prague') = CURRENT_DATE
             AND l.assigned_to = $1`,
            [agentId]
        );

        const queueResult = await pool.query(
            `SELECT COUNT(*) AS queue_size
             FROM leads
             WHERE status = 'NOVY'
             AND assigned_to = $1
             AND (ai_call_status IS NULL OR ai_call_status = 'failed')`,
            [agentId]
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
// GET /api/ai-calls/batch-results?date=&agentUserId=
// ============================================
export const getBatchResults = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const date = req.query.date as string || new Date().toISOString().split('T')[0];
        const agentId = getAgentId(req);

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
             AND l.assigned_to = $2
             ORDER BY acl.created_at DESC`,
            [date, agentId]
        );

        res.status(200).json({ date, leads: result.rows, total: result.rows.length });
    } catch (error) {
        next(error);
    }
};

// ============================================
// GET /api/ai-calls/batch-history — všichni agenti, per datum + agent
// ============================================
export const getBatchHistory = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const result = await pool.query(
            `SELECT
                DATE(acl.created_at AT TIME ZONE 'Europe/Prague')               AS datum,
                l.assigned_to                                                    AS agent_id,
                u.full_name                                                      AS agent_name,
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
             JOIN leads l ON acl.lead_id = l.id
             JOIN users u ON l.assigned_to = u.id
             WHERE acl.created_at >= NOW() - INTERVAL '30 days'
             AND u.email LIKE 'ai-agent%'
             GROUP BY DATE(acl.created_at AT TIME ZONE 'Europe/Prague'), l.assigned_to, u.full_name
             ORDER BY datum DESC, celkem_hovoru DESC`
        );

        res.status(200).json({
            batches: result.rows.map(row => ({
                datum: row.datum,
                agentId: row.agent_id,
                agentName: row.agent_name,
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
// GET /api/ai-calls/unanswered?agentUserId=
// ============================================
export const getUnanswered = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const agentId = getAgentId(req);

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
             WHERE l.status = 'NEZVEDL_TELEFON' AND l.assigned_to = $1
             GROUP BY l.id, l.phone, l.company_name, l.status
             HAVING
                COUNT(acl.recording_url) FILTER (
                    WHERE acl.recording_url IS NOT NULL AND acl.recording_url != ''
                ) = 0
                AND COUNT(acl.id) < 3
             ORDER BY l.updated_at DESC`,
            [agentId]
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
// ============================================
export const retryUnanswered = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const agentId = (req.body.agentUserId as string) || DEFAULT_AI_AGENT_ID;

        const eligibleResult = await pool.query(
            `SELECT l.id
             FROM leads l
             LEFT JOIN ai_call_logs acl ON l.id = acl.lead_id
             WHERE l.status = 'NEZVEDL_TELEFON' AND l.assigned_to = $1
             GROUP BY l.id
             HAVING
                COUNT(acl.recording_url) FILTER (
                    WHERE acl.recording_url IS NOT NULL AND acl.recording_url != ''
                ) = 0
                AND COUNT(acl.id) < 3`,
            [agentId]
        );

        const eligibleIds = eligibleResult.rows.map(r => r.id);

        if (eligibleIds.length === 0) {
            res.status(200).json({ updated: 0, message: 'Žádné leady k opakování' });
            return;
        }

        const updateResult = await pool.query(
            `UPDATE leads
             SET status = 'NOVY', ai_call_attempts = 0, ai_call_status = NULL, updated_at = NOW()
             WHERE id = ANY($1) RETURNING id`,
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
// GET /api/ai-calls/avg-duration
// ============================================
export const getAvgDuration = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const result = await pool.query(
            `SELECT ROUND(AVG(duration)) AS avg_duration, COUNT(*) AS sample_size
             FROM (
                 SELECT duration FROM ai_call_logs
                 WHERE duration IS NOT NULL AND duration > 0 AND status = 'completed'
                 ORDER BY created_at DESC LIMIT 100
             ) recent`
        );

        const avgDuration = parseInt(result.rows[0].avg_duration || 30);
        const sampleSize = parseInt(result.rows[0].sample_size || 0);
        const overhead = 8;

        res.status(200).json({ avgDuration, overhead, totalPerCall: avgDuration + overhead, sampleSize });
    } catch (error) {
        next(error);
    }
};

// ============================================
// POST /api/ai-calls/reassign-leads
// ============================================
export const reassignLeads = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { fromAgentId, toAgentId, count } = req.body;

        if (!fromAgentId || !toAgentId || !count) {
            res.status(400).json({ error: { message: 'Chybí parametry', statusCode: 400 } });
            return;
        }
        if (fromAgentId === toAgentId) {
            res.status(400).json({ error: { message: 'Zdrojový a cílový agent musí být různí', statusCode: 400 } });
            return;
        }
        if (count < 1 || count > 10000) {
            res.status(400).json({ error: { message: 'Počet musí být mezi 1 a 10000', statusCode: 400 } });
            return;
        }

        const agentsCheck = await pool.query(
            `SELECT id, full_name FROM users WHERE id = ANY($1) AND is_active = true`,
            [[fromAgentId, toAgentId]]
        );

        if (agentsCheck.rows.length !== 2) {
            res.status(400).json({ error: { message: 'Jeden nebo oba agenti nenalezeni', statusCode: 400 } });
            return;
        }

        const result = await pool.query(
            `UPDATE leads
             SET assigned_to = $1, updated_at = NOW()
             WHERE id IN (
                 SELECT id FROM leads
                 WHERE status = 'NOVY'
                 AND assigned_to = $2
                 AND (ai_call_status IS NULL OR ai_call_status = 'failed')
                 ORDER BY created_at ASC
                 LIMIT $3
             )
             RETURNING id`,
            [toAgentId, fromAgentId, count]
        );

        const reassigned = result.rows.length;
        const fromAgent = agentsCheck.rows.find((a: any) => a.id === fromAgentId);
        const toAgent = agentsCheck.rows.find((a: any) => a.id === toAgentId);

        res.status(200).json({
            success: true,
            reassigned,
            message: `${reassigned} leadů přeřazeno z ${fromAgent?.full_name} na ${toAgent?.full_name}`,
        });
    } catch (error) {
        next(error);
    }
};

// ============================================
// POST /api/ai-calls/import-leads
// ============================================
export const importLeads = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!req.file) {
            res.status(400).json({ error: { message: 'Soubor nebyl nahrán', statusCode: 400 } });
            return;
        }

        const agentId = (req.body.agentUserId as string) || DEFAULT_AI_AGENT_ID;

        const XLSX = require('xlsx');
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rawData = XLSX.utils.sheet_to_json(worksheet, {
            header: 1, defval: '', blankrows: false,
        }) as any[][];

        if (rawData.length === 0) {
            res.status(400).json({ error: { message: 'Soubor je prázdný', statusCode: 400 } });
            return;
        }

        const normalizePhone = (raw: any): string | null => {
            const str = String(raw).replace(/[\s\-\(\)\.]/g, '').trim();
            if (!str) return null;
            if (/^\+420\d{9}$/.test(str)) return str;
            if (/^00420\d{9}$/.test(str)) return `+${str.slice(2)}`;
            if (/^420\d{9}$/.test(str)) return `+${str}`;
            if (/^\d{9}$/.test(str)) return `+420${str}`;
            return null;
        };

        const phones: string[] = [];
        const invalid: string[] = [];

        for (let i = 0; i < rawData.length; i++) {
            const row = rawData[i];
            const raw = row[0];
            if (!raw) continue;
            if (i === 0 && isNaN(Number(String(raw).replace(/[\s\-\(\)\.+]/g, '')))) continue;
            const normalized = normalizePhone(raw);
            if (normalized) phones.push(normalized);
            else invalid.push(String(raw));
        }

        if (phones.length === 0) {
            res.status(400).json({
                error: { message: 'Žádná platná telefonní čísla nebyla nalezena', statusCode: 400 },
                invalid,
            });
            return;
        }

        const companyNames = phones.map(() => '');
        const legalForms = phones.map(() => '');
        const icos = phones.map(() => '');
        const contactPersons = phones.map(() => '');
        const emails = phones.map(() => '');
        const assignedTos = phones.map(() => agentId);
        const createdBys = phones.map(() => agentId);

        const insertResult = await pool.query(
            `WITH input_data AS (
                SELECT
                    unnest($1::varchar[]) as company_name,
                    unnest($2::varchar[]) as legal_form,
                    unnest($3::varchar[]) as ico,
                    unnest($4::varchar[]) as contact_person,
                    unnest($5::varchar[]) as phone,
                    unnest($6::varchar[]) as email,
                    unnest($7::uuid[]) as assigned_to,
                    unnest($8::uuid[]) as created_by
            ),
            filtered_data AS (
                SELECT id.* FROM input_data id
                LEFT JOIN leads l ON l.phone = id.phone
                WHERE l.phone IS NULL
            )
            INSERT INTO leads (
                company_name, legal_form, ico, contact_person, phone, email,
                status, invoice_promised, assigned_to, created_by, created_at, updated_at
            )
            SELECT company_name, legal_form, ico, contact_person, phone, email,
                'NOVY'::lead_status, false, assigned_to, created_by, NOW(), NOW()
            FROM filtered_data
            RETURNING phone`,
            [companyNames, legalForms, icos, contactPersons, phones, emails, assignedTos, createdBys]
        );

        const inserted = insertResult.rows.length;
        const duplicates = phones.length - inserted;

        res.status(200).json({
            success: true,
            summary: { total: phones.length, inserted, duplicates, invalid: invalid.length },
            invalidNumbers: invalid.slice(0, 50),
        });
    } catch (error) {
        next(error);
    }
};

// ============================================
// PATCH /api/ai-calls/leads/:id/blacklist
// ============================================
export const blacklistLead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;

        const leadResult = await pool.query(`SELECT id, phone, status FROM leads WHERE id = $1`, [id]);
        if (leadResult.rows.length === 0) {
            res.status(404).json({ error: { message: 'Lead nenalezen', statusCode: 404 } });
            return;
        }

        const lead = leadResult.rows[0];
        const oldStatus = lead.status;

        await pool.query(`UPDATE leads SET status = 'NEKONTAKTOVAT', updated_at = NOW() WHERE id = $1`, [id]);

        await pool.query(
            `INSERT INTO lead_comments (lead_id, user_id, old_status, new_status, comment)
             VALUES ($1, $2, $3, 'NEKONTAKTOVAT', '🚫 Přidáno na blacklist přes CRM')`,
            [id, req.user?.id || DEFAULT_AI_AGENT_ID, oldStatus]
        );

        res.status(200).json({ message: 'Lead přidán na blacklist', phone: lead.phone });
    } catch (error) {
        next(error);
    }
};

// ============================================
// POST /api/ai-calls/delete-leads
// Hromadné mazání NOVY leadů per agent
// Leady se natvrdo smažou z DB včetně deduplication záznamu
// ============================================
export const deleteLeads = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { agentId, count } = req.body;

        if (!agentId || !count) {
            res.status(400).json({ error: { message: 'Chybí parametry: agentId, count', statusCode: 400 } });
            return;
        }

        if (count < 1 || count > 10000) {
            res.status(400).json({ error: { message: 'Počet musí být mezi 1 a 10000', statusCode: 400 } });
            return;
        }

        // Ověř agenta
        const agentCheck = await pool.query(
            `SELECT id, full_name FROM users WHERE id = $1 AND is_active = true`,
            [agentId]
        );

        if (agentCheck.rows.length === 0) {
            res.status(400).json({ error: { message: 'Agent nenalezen', statusCode: 400 } });
            return;
        }

        // Nejdřív zjisti kolik jich bude smazáno
        const countResult = await pool.query(
            `SELECT COUNT(*) AS total FROM leads
             WHERE status = 'NOVY'
             AND assigned_to = $1
             AND (ai_call_status IS NULL OR ai_call_status = 'failed')`,
            [agentId]
        );

        const available = parseInt(countResult.rows[0].total);
        const toDelete = Math.min(count, available);

        if (toDelete === 0) {
            res.status(200).json({ deleted: 0, message: 'Žádné NOVY leady k mazání' });
            return;
        }

        // Smaž natvrdo — CASCADE zajistí smazání ai_call_logs, lead_comments atd.
        const result = await pool.query(
            `DELETE FROM leads
             WHERE id IN (
                 SELECT id FROM leads
                 WHERE status = 'NOVY'
                 AND assigned_to = $1
                 AND (ai_call_status IS NULL OR ai_call_status = 'failed')
                 ORDER BY created_at ASC
                 LIMIT $2
             )
             RETURNING id`,
            [agentId, toDelete]
        );

        const deleted = result.rows.length;

        res.status(200).json({
            success: true,
            deleted,
            message: `${deleted} leadů smazáno (agent: ${agentCheck.rows[0].full_name})`,
        });
    } catch (error) {
        next(error);
    }
};