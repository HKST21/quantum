import { Request, Response, NextFunction } from 'express';
import pool, { rowsToCamelCase } from '../../db/pool';
import { callOrchestrator } from '../services/callOrchestrator';
import { twilioService } from '../services/twilioService';
import { BadRequestError, NotFoundError } from '../../utils/errors';
import {
    StartAICallingRequest, StartAICallingResponse, StopAICallingResponse,
    AICallStatusResponse, AICallLog, AICallLogsQuery, AICallLogsResponse,
} from '../types/aiCalls.types';

const DEFAULT_AI_AGENT_ID = '53c65ca7-68bc-4948-83e5-35a64c17f0fb';

export const startAICalling = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { leadIds, maxCalls = 50, agentUserId } = req.body as StartAICallingRequest & { agentUserId?: string };

        // Použij agentUserId z requestu nebo default z env
        const activeAgentId = agentUserId || process.env.AI_AGENT_USER_ID || DEFAULT_AI_AGENT_ID;

        console.log(`🚀 AI Calling start requested by: ${req.user?.fullName} | Agent: ${activeAgentId}`);

        // Ověř že agent existuje
        const agentCheck = await pool.query(
            `SELECT id, full_name FROM users WHERE id = $1 AND is_active = true`,
            [activeAgentId]
        );
        if (agentCheck.rows.length === 0) throw new BadRequestError(`Agent ${activeAgentId} nenalezen nebo není aktivní`);

        console.log(`🤖 Using agent: ${agentCheck.rows[0].full_name}`);

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

        console.log(`✅ Found ${leads.length} leads to call`);

        setImmediate(async () => {
            console.log('🎯 Starting sequential calling...');
            for (const lead of leads) {
                try {
                    console.log(`📞 Calling lead ${lead.id} (${lead.phone})...`);
                    await callOrchestrator.processLead(lead.id, activeAgentId);
                    console.log(`✅ Call completed for ${lead.id}`);
                } catch (error) {
                    console.error(`❌ Call failed for ${lead.id}:`, error);
                }
            }
            console.log('🎉 All calls completed!');
        });

        res.status(200).json({
            success: true,
            message: `AI calling started for ${leads.length} leads`,
            queuedLeads: leads.length,
            aiAgentId: activeAgentId,
            agentName: agentCheck.rows[0].full_name,
        } as StartAICallingResponse & { agentName: string });
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
        const currentCallResult = await pool.query(
            `SELECT l.id, l.company_name, l.phone, l.ai_call_status, l.ai_last_call_at
             FROM leads l WHERE l.ai_call_status = 'calling' LIMIT 1`
        );

        const currentCall = currentCallResult.rows.length > 0 ? {
            leadId: currentCallResult.rows[0].id,
            companyName: currentCallResult.rows[0].company_name,
            phone: currentCallResult.rows[0].phone,
            aiCallStatus: currentCallResult.rows[0].ai_call_status,
            startedAt: currentCallResult.rows[0].ai_last_call_at,
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
            isRunning: currentCall !== null,
            currentCall,
            queueSize: parseInt(queueResult.rows[0].count),
            completedToday: parseInt(todayResult.rows[0].completed || 0),
            successfulToday: parseInt(todayResult.rows[0].successful || 0),
        } as AICallStatusResponse);
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
                    error_message, recording_url, recording_sid, started_at, completed_at, created_at
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
            `SELECT id, outcome, lead_id FROM ai_call_logs WHERE call_sid = $1`, [CallSid]
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