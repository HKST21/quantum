// ============================================
// BATCH JOBS — živý přehled dávky na ústředně + stažení podrobného logu
//
// Data zapisuje worker na ústředně (ustredna-quantum):
//   - batch_jobs      = fronta / stav úkolů (už existuje, migrace 001)
//   - batch_job_logs  = celý výpis workeru po kouscích (migrace 004, uchování 3 dny)
// Tady se jen ČTE. Všechny endpointy jsou jen pro ADMIN (guard je v batchCalls.routes.ts).
//
//   GET /api/ai-calls/batch-jobs/active        běžící / čekající dávka + posledních pár řádků logu + poslední dávky
//   GET /api/ai-calls/batch-jobs?date=&agentUserId=   dávky (úkoly) pro daný den a agenta
//   GET /api/ai-calls/batch-jobs/summary       které dny/agenti mají uložený log (pro Historii dávek)
//   GET /api/ai-calls/batch-jobs/:id/log       stažení celého logu jako .txt
// ============================================

import { Request, Response, NextFunction } from 'express';
import pool from '../../db/pool';

const TZ = 'Europe/Prague';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TAIL_LINES = 14;
const DOWNLOAD_PAGE = 100; // kousků logu na jeden dotaz při stahování

const fmtPrague = (d: Date | string | null | undefined): string => {
    if (!d) return '—';
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return '—';
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(dt);
};

const slug = (s: string): string =>
    (s || 'agent').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';

const mapJob = (r: any) => ({
    id: r.id as string,
    agentId: r.agent_user_id as string,
    agentName: (r.agent_name as string) || 'Neznámý agent',
    status: r.status as string,
    queuedLeads: r.queued_leads === null ? null : Number(r.queued_leads),
    processedLeads: Number(r.processed_leads || 0),
    maxCalls: Number(r.max_calls || 0),
    stopRequested: !!r.stop_requested,
    errorMessage: (r.error_message as string) || null,
    createdAt: r.created_at,
    startedAt: r.started_at,
    heartbeatAt: r.heartbeat_at,
    finishedAt: r.finished_at,
    hasLog: !!r.has_log,
    logBytes: Number(r.log_bytes || 0),
});

const JOB_SELECT = `
    SELECT j.*, u.full_name AS agent_name,
           EXTRACT(EPOCH FROM (NOW() - j.heartbeat_at))::int AS hb_age,
           EXISTS (SELECT 1 FROM batch_job_logs l WHERE l.job_id = j.id) AS has_log,
           COALESCE((SELECT SUM(LENGTH(l.content)) FROM batch_job_logs l WHERE l.job_id = j.id), 0) AS log_bytes
    FROM batch_jobs j
    JOIN users u ON u.id = j.agent_user_id`;

// ============================================
// GET /api/ai-calls/batch-jobs/active
// ============================================
export const getActiveBatchJob = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const activeRes = await pool.query(
            `${JOB_SELECT}
             WHERE j.status IN ('pending', 'running')
             ORDER BY (j.status = 'running') DESC, j.created_at DESC
             LIMIT 1`
        );

        let active: any = null;
        if (activeRes.rows.length > 0) {
            const row = activeRes.rows[0];
            const lastRes = await pool.query(
                `SELECT created_at, EXTRACT(EPOCH FROM (NOW() - created_at))::int AS age
                 FROM batch_job_logs WHERE job_id = $1 ORDER BY seq DESC LIMIT 1`,
                [row.id]
            );
            const tailRes = await pool.query(
                `SELECT content FROM batch_job_logs WHERE job_id = $1 ORDER BY seq DESC LIMIT 3`,
                [row.id]
            );
            const text = tailRes.rows.map((r: any) => r.content as string).reverse().join('');
            const lines = text.split('\n').filter((l) => l.length > 0);

            active = {
                ...mapJob(row),
                lastLogAt: lastRes.rows[0]?.created_at ?? null,
                lastLogAgeSec: lastRes.rows[0] ? Number(lastRes.rows[0].age) : null,
                heartbeatAgeSec: row.heartbeat_at ? Number(row.hb_age) : null,
                tail: lines.slice(-TAIL_LINES),
            };
        }

        // Poslední dávky (logy se uchovávají 3 dny) — ať jde log stáhnout i po skončení dávky.
        const recentRes = await pool.query(
            `${JOB_SELECT}
             WHERE j.status IN ('completed', 'stopped', 'failed')
               AND j.created_at >= NOW() - INTERVAL '4 days'
             ORDER BY COALESCE(j.finished_at, j.created_at) DESC
             LIMIT 8`
        );

        res.status(200).json({ active, recent: recentRes.rows.map(mapJob) });
    } catch (error) {
        next(error);
    }
};

// ============================================
// GET /api/ai-calls/batch-jobs?date=YYYY-MM-DD&agentUserId=
// Dávky (úkoly), které ten den běžely (překrývají den v časové zóně Europe/Prague).
// ============================================
export const getBatchJobsForDay = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const date = String(req.query.date || '').slice(0, 10);
        const agentUserId = (req.query.agentUserId as string) || null;

        if (!DATE_RE.test(date)) {
            res.status(400).json({ error: { message: 'Chybí nebo je neplatné datum (YYYY-MM-DD)' } });
            return;
        }
        if (agentUserId && !UUID_RE.test(agentUserId)) {
            res.status(400).json({ error: { message: 'Neplatné ID agenta' } });
            return;
        }

        const result = await pool.query(
            `${JOB_SELECT}
             WHERE ($2::uuid IS NULL OR j.agent_user_id = $2::uuid)
               AND j.status <> 'pending'
               AND COALESCE(j.started_at, j.created_at) <  ((($1::date) + 1)::timestamp AT TIME ZONE '${TZ}')
               AND COALESCE(j.finished_at, NOW())        >= (($1::date)::timestamp AT TIME ZONE '${TZ}')
             ORDER BY COALESCE(j.started_at, j.created_at) ASC`,
            [date, agentUserId]
        );

        res.status(200).json({ date, jobs: result.rows.map(mapJob) });
    } catch (error) {
        next(error);
    }
};

// ============================================
// GET /api/ai-calls/batch-jobs/summary
// Pro Historii dávek: které dny a agenti mají uložený log (a ID těch úkolů).
// ============================================
export const getBatchJobsSummary = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const result = await pool.query(
            `SELECT d.day::date::text AS day, j.agent_user_id AS agent_id,
                    COUNT(*)::int AS logs,
                    ARRAY_AGG(j.id ORDER BY COALESCE(j.started_at, j.created_at)) AS job_ids
             FROM batch_jobs j
             CROSS JOIN LATERAL generate_series(
                 (COALESCE(j.started_at, j.created_at) AT TIME ZONE '${TZ}')::date::timestamp,
                 (COALESCE(j.finished_at, NOW())        AT TIME ZONE '${TZ}')::date::timestamp,
                 INTERVAL '1 day'
             ) AS d(day)
             WHERE j.created_at >= NOW() - INTERVAL '5 days'
               AND EXISTS (SELECT 1 FROM batch_job_logs l WHERE l.job_id = j.id)
             GROUP BY d.day, j.agent_user_id`
        );

        res.status(200).json({
            days: result.rows.map((r: any) => ({
                date: String(r.day).slice(0, 10),
                agentId: r.agent_id as string,
                logs: Number(r.logs),
                jobIds: r.job_ids as string[],
            })),
        });
    } catch (error) {
        next(error);
    }
};

// ============================================
// GET /api/ai-calls/batch-jobs/:id/log  — stažení celého logu (.txt)
// ============================================
export const downloadBatchJobLog = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const id = String(req.params.id || '');
        if (!UUID_RE.test(id)) {
            res.status(400).json({ error: { message: 'Neplatné ID úkolu' } });
            return;
        }

        const jobRes = await pool.query(
            `SELECT j.*, u.full_name AS agent_name, rq.full_name AS requested_by_name
             FROM batch_jobs j
             JOIN users u ON u.id = j.agent_user_id
             LEFT JOIN users rq ON rq.id = j.requested_by
             WHERE j.id = $1`,
            [id]
        );
        if (jobRes.rows.length === 0) {
            res.status(404).json({ error: { message: 'Úkol nenalezen' } });
            return;
        }
        const job = jobRes.rows[0];

        const first = await pool.query(`SELECT 1 FROM batch_job_logs WHERE job_id = $1 LIMIT 1`, [id]);
        if (first.rows.length === 0) {
            res.status(404).json({ error: { message: 'Log tohoto úkolu není k dispozici (uchovává se jen 3 dny, nebo se u této dávky neukládal).' } });
            return;
        }

        const start = job.started_at || job.created_at;
        const d = fmtPrague(start); // "2026-11-03 13:05:12"
        const filename = `log-ustredna_${d.slice(0, 10)}_${d.slice(11, 16).replace(':', '-')}_${slug(job.agent_name)}_${id.slice(0, 8)}.txt`;

        res.status(200);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');

        let aborted = false;
        res.on('close', () => { if (!res.writableEnded) aborted = true; });

        const write = async (text: string): Promise<void> => {
            if (aborted) return;
            if (!res.write(text)) {
                await new Promise<void>((resolve) => {
                    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
                    res.once('drain', done);
                    res.once('close', done);
                });
            }
        };

        const stillRunning = job.status === 'running' || job.status === 'pending';
        await write(
            [
                '# Podrobný log dávky — ústředna (ustredna-quantum)',
                `# Úkol:        ${job.id}`,
                `# Agent:       ${job.agent_name} (${job.agent_user_id})`,
                `# Zadal:       ${job.requested_by_name || '—'}`,
                `# Stav:        ${job.status}${stillRunning ? ' — ÚKOL JEŠTĚ BĚŽÍ, log je průběžný' : ''}${job.error_message ? ` | chyba: ${job.error_message}` : ''}`,
                `# Leady:       zpracováno ${job.processed_leads ?? 0} z ${job.queued_leads ?? '?'} (max_calls ${job.max_calls})`,
                `# Vytvořen:    ${fmtPrague(job.created_at)}`,
                `# Spuštěn:     ${fmtPrague(job.started_at)}`,
                `# Dokončen:    ${fmtPrague(job.finished_at)}`,
                `# Čas v řádcích: ${TZ} (YYYY-MM-DD HH:mm:ss.SSS)`,
                `# Staženo:     ${fmtPrague(new Date())} (${req.user?.fullName ?? '—'})`,
                '#',
                '# Jak číst (hledej podle telefonu nebo 6místného označení hovoru, které je v řádcích Lead / ARI / Timeline / Gemini / Zákazník):',
                '#   [Lead xxxxxx] START / VÝSLEDEK / PŘEPIS / SELHÁNÍ  — shrnutí jednoho leadu (telefon, SIP jméno, CLIP, výsledek, přepis)',
                '#   [ARI xxxxxx]                                      — surové události z Asterisku s časem od vytočení (stavy kanálu, příčina ukončení)',
                '#   [Timeline xxxxxx]                                 — časová osa hovoru: originate → zvonění → zvednutí → zánik kanálu + cause',
                '#   [Zákazník xxxxxx] AUDIO / ÚROVEŇ PO SEKUNDÁCH     — zda a kolik zákazník mluvil (hláška operátora / hlasovka / ticho)',
                '#   [Gemini xxxxxx]                                   — co řekla Eva (AI / Eva řekla) a co slyšela (User)',
                '# ' + '='.repeat(100),
                '',
                '',
            ].join('\n')
        );

        let lastSeq = -1;
        let totalChunks = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (aborted) break;
            const page = await pool.query(
                `SELECT seq, content FROM batch_job_logs WHERE job_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT ${DOWNLOAD_PAGE}`,
                [id, lastSeq]
            );
            if (page.rows.length === 0) break;
            for (const row of page.rows) {
                await write(row.content as string);
                lastSeq = Number(row.seq);
                totalChunks++;
            }
            if (page.rows.length < DOWNLOAD_PAGE) break;
        }

        await write(`\n# ===== KONEC LOGU (${totalChunks} kousků) =====\n`);
        if (!aborted) res.end();
        console.log(`📥 [BatchJobs] Log úkolu ${id} stáhl ${req.user?.fullName ?? '?'} (${totalChunks} kousků)`);
    } catch (error) {
        if (res.headersSent) {
            // uprostřed streamu už nejde poslat JSON chybu
            console.error('❌ [BatchJobs] Chyba při stahování logu:', error);
            res.end();
            return;
        }
        next(error);
    }
};