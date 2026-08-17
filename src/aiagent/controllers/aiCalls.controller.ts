import { Request, Response, NextFunction } from 'express';
import pool, { rowsToCamelCase } from '../../db/pool';
import { callOrchestrator } from '../services/callOrchestrator';
import { twilioService } from '../services/twilioService';
import { BadRequestError, NotFoundError } from '../../utils/errors';
import { odorikService } from '../services/odorikService';
import {
    StartAICallingRequest, StartAICallingResponse, StopAICallingResponse,
    AICallStatusResponse, AICallLog, AICallLogsQuery, AICallLogsResponse,
    CallEngine, CallProvider,
} from '../types/aiCalls.types';

const DEFAULT_AI_AGENT_ID = '53c65ca7-68bc-4948-83e5-35a64c17f0fb';

// ============================================
// HELPER: načti čísla workerů z ENV
// AI_PHONE_1, AI_PHONE_2, ... AI_PHONE_5
// Fallback na TWILIO_PHONE_NUMBER
// ============================================
const getWorkerPhoneNumbers = (): string[] => {
    const numbers: string[] = [];
    let i = 1;
    while (true) {
        const num = process.env[`AI_PHONE_${i}`];
        if (!num) break;
        numbers.push(num);
        i++;
    }
    if (numbers.length === 0 && process.env.TWILIO_PHONE_NUMBER) {
        numbers.push(process.env.TWILIO_PHONE_NUMBER);
    }
    return numbers;
};

// ============================================
// POST /api/ai-calls/start
//
// ⚠️ SJEDNOCENO — dřív to byly dva oddělené endpointy
// (startAICalling pro Twilio, startOdorikCalling pro Odorik). Teď je
// to jeden endpoint se dvěma nezávislými parametry:
//
//   provider: 'twilio' | 'odorik'  (default 'twilio' — zpětně kompatibilní)
//   engine:   'openai' | 'gemini'  (default 'openai' — zpětně kompatibilní)
//
// Staré volání bez těchto polí se chová 1:1 jako dřív.
// ============================================
export const startAICalling = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const {
            leadIds,
            maxCalls = 50,
            agentUserId,
            workers = 1,
            provider = 'twilio',
            engine = 'openai',
        } = req.body as StartAICallingRequest & { agentUserId?: string; workers?: number };

        const activeAgentId = agentUserId || process.env.AI_AGENT_USER_ID || DEFAULT_AI_AGENT_ID;

        const validProviders = ['twilio', 'odorik'];
        const activeProvider = (validProviders.includes(provider as string) ? provider : 'twilio') as CallProvider;

        const validEngines = ['openai', 'gemini'];
        const activeEngine = (validEngines.includes(engine as string) ? engine : 'openai') as CallEngine;

        console.log(`🚀 AI Calling start requested by: ${req.user?.fullName} | Agent: ${activeAgentId}`);
        console.log('📋 Parameters:', { leadIds, maxCalls, agentUserId: activeAgentId, workers, provider: activeProvider, engine: activeEngine });

        // Ověř agenta
        const agentCheck = await pool.query(
            `SELECT id, full_name FROM users WHERE id = $1 AND is_active = true`,
            [activeAgentId]
        );
        if (agentCheck.rows.length === 0) throw new BadRequestError(`Agent ${activeAgentId} nenalezen`);

        // Načti dostupné identifikátory workerů podle providera
        let callerIdentifiers: string[];

        if (activeProvider === 'odorik') {
            callerIdentifiers = odorikService.getActiveSipNames();
            if (callerIdentifiers.length === 0) {
                throw new BadRequestError('Žádná ODORIK_SIP_NAME_X jména nejsou nakonfigurována v ENV');
            }
            if (!process.env.ODORIK_PHONE_NUMBER) {
                throw new BadRequestError('ODORIK_PHONE_NUMBER není nakonfigurováno v ENV');
            }
        } else {
            callerIdentifiers = getWorkerPhoneNumbers();
            if (callerIdentifiers.length === 0) {
                throw new BadRequestError('Žádná AI_PHONE_X čísla nejsou nakonfigurována');
            }
        }

        const actualWorkers = Math.min(Math.max(1, workers), callerIdentifiers.length);
        if (actualWorkers < workers) {
            console.warn(`⚠️ Požadováno ${workers} workerů ale máme ${callerIdentifiers.length} ${activeProvider === 'odorik' ? 'SIP jmen' : 'čísel'} → spouštíme ${actualWorkers}`);
        }

        console.log(`📞 Worker ${activeProvider === 'odorik' ? 'SIP jména' : 'čísla'} (${actualWorkers}):`, callerIdentifiers.slice(0, actualWorkers));

        let leads;
        if (leadIds && leadIds.length > 0) {
            const result = await pool.query(
                `SELECT id, company_name, contact_person, phone
                 FROM leads
                 WHERE id = ANY($1) AND status = 'NOVY' AND assigned_to = $2`,
                [leadIds, activeAgentId]
            );
            leads = result.rows;
        } else {
            leads = await callOrchestrator.getLeadsForCalling(activeAgentId, maxCalls);
        }

        if (leads.length === 0) throw new BadRequestError('Žádné leady k volání');

        console.log(`✅ Found ${leads.length} leads to call (${actualWorkers} workers, provider=${activeProvider}, engine=${activeEngine})`);

        const workerLeads: any[][] = Array.from({ length: actualWorkers }, () => []);
        leads.forEach((lead: any, index: number) => {
            workerLeads[index % actualWorkers].push(lead);
        });

        workerLeads.forEach((chunk, i) => {
            console.log(`👷 Worker ${i + 1} (${callerIdentifiers[i]}): ${chunk.length} leadů`);
        });

        setImmediate(async () => {
            console.log(`🎯 Starting ${actualWorkers} parallel workers (provider: ${activeProvider}, engine: ${activeEngine})...`);

            const workerPromises = workerLeads.map((chunk, workerIndex) => {
                const callerIdentifier = callerIdentifiers[workerIndex];

                return (async () => {
                    console.log(`🟢 Worker ${workerIndex + 1} (${callerIdentifier}) started with ${chunk.length} leads`);

                    for (const lead of chunk) {
                        try {
                            console.log(`📞 [Worker ${workerIndex + 1}] Calling ${lead.id} (${lead.phone})...`);
                            await callOrchestrator.processLead(lead.id, activeAgentId, activeEngine, activeProvider, callerIdentifier);
                            console.log(`✅ [Worker ${workerIndex + 1}] Done: ${lead.id}`);
                        } catch (error) {
                            console.error(`❌ [Worker ${workerIndex + 1}] Failed: ${lead.id}:`, error);
                        }
                    }

                    console.log(`🏁 Worker ${workerIndex + 1} (${callerIdentifier}) finished`);
                })();
            });

            await Promise.all(workerPromises);
            console.log('🎉 All workers completed!');
        });

        res.status(200).json({
            success: true,
            message: `AI calling started: ${actualWorkers} workerů, ${leads.length} leadů (provider=${activeProvider}, engine=${activeEngine})`,
            queuedLeads: leads.length,
            aiAgentId: activeAgentId,
            agentName: agentCheck.rows[0].full_name,
            workers: actualWorkers,
            provider: activeProvider,
            engine: activeEngine,
            workerIdentifiers: callerIdentifiers.slice(0, actualWorkers),
            leadsPerWorker: workerLeads.map((chunk, i) => ({
                worker: i + 1,
                identifier: callerIdentifiers[i],
                leads: chunk.length,
            })),
        } as StartAICallingResponse & Record<string, any>);
    } catch (error) {
        next(error);
    }
};

export const stopAICalling = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        console.log('🛑 AI Calling stop requested by:', req.user?.fullName);
        res.status(200).json({
            success: true,
            message: 'Stop not yet implemented - calls will complete naturally',
            stoppedCalls: 0,
        } as StopAICallingResponse);
    } catch (error) {
        next(error);
    }
};

export const getAICallStatus = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const activeCallsResult = await pool.query(
            `SELECT l.id, l.company_name, l.phone, l.ai_call_status, l.ai_last_call_at
             FROM leads l WHERE l.ai_call_status = 'calling'`
        );

        const currentCall = activeCallsResult.rows.length > 0 ? {
            leadId: activeCallsResult.rows[0].id,
            companyName: activeCallsResult.rows[0].company_name,
            phone: activeCallsResult.rows[0].phone,
            aiCallStatus: activeCallsResult.rows[0].ai_call_status,
            startedAt: activeCallsResult.rows[0].ai_last_call_at,
        } : null;

        const queueResult = await pool.query(
            `SELECT COUNT(*) as count FROM leads WHERE status = 'NOVY' AND assigned_to = $1`,
            [process.env.AI_AGENT_USER_ID || DEFAULT_AI_AGENT_ID]
        );

        const todayResult = await pool.query(
            `SELECT
                COUNT(*) FILTER (WHERE status = 'completed') as completed,
                COUNT(*) FILTER (WHERE outcome = 'CHCE_KONTAKT_AI') as successful
             FROM ai_call_logs WHERE DATE(created_at) = CURRENT_DATE`
        );

        res.status(200).json({
            isRunning: activeCallsResult.rows.length > 0,
            activeCalls: activeCallsResult.rows.length,
            currentCall,
            queueSize: parseInt(queueResult.rows[0].count),
            completedToday: parseInt(todayResult.rows[0].completed || 0),
            successfulToday: parseInt(todayResult.rows[0].successful || 0),
        } as AICallStatusResponse & Record<string, any>);
    } catch (error) {
        next(error);
    }
};

export const getAICallLogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { leadId, status, outcome, startDate, endDate, limit = 50, offset = 0 } = req.query as any as AICallLogsQuery;

        const conditions: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        if (leadId) { conditions.push(`lead_id = $${paramIndex}`); params.push(leadId); paramIndex++; }
        if (status) { conditions.push(`status = $${paramIndex}`); params.push(status); paramIndex++; }
        if (outcome) { conditions.push(`outcome = $${paramIndex}`); params.push(outcome); paramIndex++; }
        if (startDate) { conditions.push(`created_at >= $${paramIndex}`); params.push(startDate); paramIndex++; }
        if (endDate) { conditions.push(`created_at <= $${paramIndex}`); params.push(endDate); paramIndex++; }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countResult = await pool.query(`SELECT COUNT(*) as total FROM ai_call_logs ${whereClause}`, params);
        const total = parseInt(countResult.rows[0].total);

        params.push(limit, offset);
        const result = await pool.query(
            `SELECT id, lead_id, call_sid, status, outcome, duration, transcript, ai_notes,
                    error_message, recording_url, recording_sid, started_at, completed_at, created_at, engine
             FROM ai_call_logs ${whereClause}
             ORDER BY created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            params
        );

        const logs = rowsToCamelCase<AICallLog>(result.rows);
        const page = Math.floor((offset as number) / (limit as number)) + 1;

        res.status(200).json({ logs, total, page, limit: limit as number } as AICallLogsResponse);
    } catch (error) {
        next(error);
    }
};

export const getAICallLogDetail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            `SELECT acl.*, l.company_name, l.contact_person, l.phone, l.status as lead_status
             FROM ai_call_logs acl
             INNER JOIN leads l ON acl.lead_id = l.id
             WHERE acl.id = $1`,
            [id]
        );

        if (result.rows.length === 0) throw new NotFoundError('Call log not found');

        res.status(200).json({ log: result.rows[0] });
    } catch (error) {
        next(error);
    }
};

export const getTwiML = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const callSid = req.body.CallSid;
        console.log('📋 TwiML requested for call:', callSid);
        const twiml = twilioService.generateTwiML(callSid);
        res.type('text/xml');
        res.send(twiml);
    } catch (error) {
        next(error);
    }
};

export const handleStatusCallback = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { CallSid, CallDuration } = req.body;
        console.log('📞 Twilio status callback:', { CallSid });

        await pool.query(
            `UPDATE ai_call_logs SET duration = COALESCE(duration, $1) WHERE call_sid = $2`,
            [CallDuration || 0, CallSid]
        );

        res.status(200).send('OK');
    } catch (error) {
        next(error);
    }
};

export const handleRecordingCallback = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    try {
        const { RecordingSid, RecordingUrl, RecordingStatus, CallSid } = req.body;

        console.log('🎙️ Recording callback:', { RecordingSid, RecordingStatus, CallSid });

        if (RecordingStatus !== 'completed') {
            res.status(200).send('OK');
            return;
        }

        const callLogResult = await pool.query(
            `SELECT id FROM ai_call_logs WHERE call_sid = $1`, [CallSid]
        );

        if (callLogResult.rows.length === 0) {
            res.status(200).send('OK');
            return;
        }

        await pool.query(
            `UPDATE ai_call_logs SET recording_url = $1, recording_sid = $2 WHERE call_sid = $3`,
            [`${RecordingUrl}.mp3`, RecordingSid, CallSid]
        );

        console.log('✅ Recording URL saved');
        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Recording callback error:', error);
        res.status(200).send('OK');
    }
};

// ============================================
// POST /api/ai-calls/test-odorik
//
// ⚠️ POZOR — beze změny chování oproti původní verzi: tenhle test
// endpoint historicky NEVOLÁ odorikService.setForward() a nestaví
// sip: URI destinaci — jen dial lead.phone přímo s "from" nastaveným
// na ODORIK_PHONE_NUMBER. Proto se volá s provider='twilio' (ne
// 'odorik') — kdyby se dal 'odorik', processLead by navíc zavolal
// setForward(), což tenhle test dřív nedělal. Pro test i setForward
// kroku použij /start s provider='odorik'.
// ============================================
export const startOdorikTestCall = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { leadId } = req.body;

        if (!leadId) {
            throw new BadRequestError('leadId je povinný v request body');
        }

        const odorikNumber = process.env.ODORIK_PHONE_NUMBER;
        if (!odorikNumber) {
            throw new BadRequestError('ODORIK_PHONE_NUMBER není nakonfigurováno v ENV');
        }

        console.log(`🧪 Odorik test call requested by: ${req.user?.fullName}`);
        console.log(`📞 Lead ID: ${leadId} | From: ${odorikNumber}`);

        const activeAgentId = process.env.AI_AGENT_USER_ID || DEFAULT_AI_AGENT_ID;

        const leadCheck = await pool.query(
            `SELECT id, company_name, contact_person, phone
             FROM leads
             WHERE id = $1`,
            [leadId]
        );

        if (leadCheck.rows.length === 0) {
            throw new BadRequestError(`Lead ${leadId} nenalezen v DB`);
        }

        const lead = leadCheck.rows[0];

        console.log(`🚀 [ODORIK TEST] Volám: ${lead.phone} přes ${odorikNumber}`);

        setImmediate(async () => {
            try {
                await callOrchestrator.processLead(leadId, activeAgentId, 'openai', 'twilio', odorikNumber);
                console.log(`✅ [ODORIK TEST] Hovor dokončen pro lead ${leadId}`);
            } catch (error) {
                console.error(`❌ [ODORIK TEST] Chyba:`, error);
            }
        });

        res.status(200).json({
            success: true,
            message: 'Odorik testovací hovor spuštěn',
            leadId,
            leadPhone: lead.phone,
            fromNumber: odorikNumber,
            agentId: activeAgentId,
        });
    } catch (error) {
        next(error);
    }
};

// ============================================
// GET /api/ai-calls/odorik-config
// ============================================
export const getOdorikConfig = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const sipNames = odorikService.getActiveSipNames();
        const odorikNumber = process.env.ODORIK_PHONE_NUMBER || null;

        res.status(200).json({
            sipNames,
            maxWorkers: sipNames.length,
            odorikPhoneNumber: odorikNumber,
        });
    } catch (error) {
        next(error);
    }
};