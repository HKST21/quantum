import pool from '../../db/pool';
import { twilioService } from './twilioService';
import { callHandler } from '../websockets/callHandler';
import { AICallOutcome, ConversationOutcome } from '../types/aiCalls.types';
import Twilio from 'twilio';

export class CallOrchestrator {
    private twilioClient: Twilio.Twilio;

    constructor() {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        if (!accountSid || !authToken) throw new Error('Twilio credentials not configured');
        this.twilioClient = Twilio(accountSid, authToken);
    }

    async getLeadsForCalling(limit: number = 50): Promise<any[]> {
        try {
            const aiAgentId = process.env.AI_AGENT_USER_ID;
            if (!aiAgentId) throw new Error('AI_AGENT_USER_ID not configured');

            const result = await pool.query(
                `SELECT id, company_name, contact_person, phone, email
                 FROM leads
                 WHERE status = 'NOVY'
                 AND assigned_to = $1
                 AND (ai_call_status IS NULL OR ai_call_status = 'failed')
                 ORDER BY created_at ASC
                 LIMIT $2`,
                [aiAgentId, limit]
            );

            console.log(`✅ Found ${result.rows.length} leads ready for calling`);
            return result.rows;
        } catch (error) {
            console.error('❌ Failed to fetch leads for calling:', error);
            throw error;
        }
    }

    async processLead(leadId: string): Promise<void> {
        let callSid: string | null = null;

        try {
            console.log('🎯 Processing lead:', leadId);

            const leadResult = await pool.query(
                `SELECT id, company_name, contact_person, phone, email FROM leads WHERE id = $1`,
                [leadId]
            );

            if (leadResult.rows.length === 0) throw new Error(`Lead ${leadId} not found`);

            const lead = leadResult.rows[0];

            console.log('📞 Calling lead:', { id: lead.id, company: lead.company_name, phone: lead.phone });

            // Validate carrier
            console.log('🔍 Validating carrier for:', lead.phone);
            const validation = await this.validateCarrier(lead.phone);

            await pool.query(
                `UPDATE leads
                 SET carrier = $1, line_type = $2, mobile_network_code = $3, phone_validated_at = NOW()
                 WHERE id = $4`,
                [validation.carrier, validation.lineType, validation.mobileNetworkCode, leadId]
            );

            if (validation.isVodafone) {
                console.log('❌ SKIP - Vodafone customer detected');
                await this.skipVodafoneLead(leadId, validation.carrier);
                return;
            }

            await pool.query(
                `UPDATE leads
                 SET ai_call_status = 'calling', ai_last_call_at = NOW(),
                     ai_call_attempts = COALESCE(ai_call_attempts, 0) + 1, updated_at = NOW()
                 WHERE id = $1`,
                [leadId]
            );

            const callResponse = await twilioService.initiateCall(lead.phone, leadId);
            callSid = callResponse.sid;

            console.log('✅ Twilio call initiated:', callSid);

            await pool.query(
                `INSERT INTO ai_call_logs (lead_id, call_sid, status, started_at) VALUES ($1, $2, 'calling', NOW())`,
                [leadId, callSid]
            );

            const maxWaitTime = 90000;
            const pollInterval = 2000;
            let elapsed = 0;

            while (elapsed < maxWaitTime) {
                await this.sleep(pollInterval);
                elapsed += pollInterval;

                const callData = callHandler.getCallData(callSid);
                if (callData && callData.outcome) {
                    console.log('✅ Call completed with outcome:', callData.outcome);
                    await this.updateLeadAfterCall(leadId, callSid, callData.outcome, callData.transcript, elapsed / 1000);
                    return;
                }

                const twilioStatus = await twilioService.getCallStatus(callSid);

                if (['completed', 'failed', 'busy', 'no-answer'].includes(twilioStatus.status)) {
                    console.log('📞 Twilio call ended:', twilioStatus.status);
                    await this.updateLeadAfterCall(
                        leadId, callSid,
                        { outcome: 'no_answer', transcript: '', aiNotes: `Call ended: ${twilioStatus.status}`, duration: 0, confidence: 1.0 },
                        `Call ended: ${twilioStatus.status}`,
                        twilioStatus.duration || elapsed / 1000
                    );
                    return;
                }
            }

            console.warn('⏰ Call timeout reached');
            callHandler.forceCleanup(callSid);
            await this.updateLeadAfterCall(
                leadId, callSid,
                { outcome: 'no_answer', transcript: '', aiNotes: 'Call timeout (90s)', duration: 90, confidence: 1.0 },
                'Call timeout',
                maxWaitTime / 1000
            );
        } catch (error: any) {
            console.error('❌ Call processing failed:', error);

            await pool.query(
                `UPDATE leads SET ai_call_status = 'failed', updated_at = NOW() WHERE id = $1`,
                [leadId]
            );

            if (callSid) {
                await pool.query(
                    `UPDATE ai_call_logs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE call_sid = $2`,
                    [error.message, callSid]
                );
            }

            throw error;
        }
    }

    private async validateCarrier(phoneNumber: string): Promise<{
        isVodafone: boolean;
        carrier: string | null;
        lineType: string | null;
        mobileNetworkCode: string | null;
    }> {
        try {
            const lookup = await this.twilioClient.lookups.v2
                .phoneNumbers(phoneNumber)
                .fetch({ fields: 'line_type_intelligence' });

            const carrierName = lookup.lineTypeIntelligence?.carrier_name || null;
            const lineType = lookup.lineTypeIntelligence?.type || null;
            const mobileNetworkCode = lookup.lineTypeIntelligence?.mobile_network_code || null;
            const isVodafone = this.isVodafoneCarrier(carrierName, mobileNetworkCode);

            console.log('✅ Carrier validation:', { carrier: carrierName, isVodafone });

            return { isVodafone, carrier: carrierName, lineType, mobileNetworkCode };
        } catch (error) {
            console.warn('⚠️ Carrier validation failed - proceeding optimistically');
            return { isVodafone: false, carrier: null, lineType: null, mobileNetworkCode: null };
        }
    }

    private isVodafoneCarrier(carrierName: string | null | undefined, mobileNetworkCode: string | null | undefined): boolean {
        if (carrierName?.toLowerCase().includes('vodafone')) return true;
        if (mobileNetworkCode === '03') return true;
        return false;
    }

    private async skipVodafoneLead(leadId: string, carrier: string | null): Promise<void> {
        const aiAgentId = process.env.AI_AGENT_USER_ID;

        await pool.query(
            `UPDATE leads SET status = 'NEKONTAKTOVAT', ai_call_status = 'skipped', updated_at = NOW() WHERE id = $1`,
            [leadId]
        );

        await pool.query(
            `INSERT INTO lead_comments (lead_id, user_id, old_status, new_status, comment)
             VALUES ($1, $2, 'NOVY', 'NEKONTAKTOVAT', $3)`,
            [leadId, aiAgentId, `🤖 Automaticky přeskočeno - zákazník má Vodafone\nOperátor: ${carrier || 'Vodafone Czech Republic'}`]
        );

        console.log('✅ Vodafone lead skipped:', leadId);
    }

    private async updateLeadAfterCall(
        leadId: string,
        callSid: string,
        outcome: ConversationOutcome,
        transcript: string,
        duration: number
    ): Promise<void> {
        const statusMap: Record<string, string> = {
            interested: 'CHCE_KONTAKT_AI',
            not_interested: 'ODMITNUTO',
            callback: 'ODKLADA',
            aggressive: 'NEKONTAKTOVAT',
            already_vodafone: 'NEKONTAKTOVAT',
            wrong_person: 'NEKONTAKTOVAT',
            no_answer: 'NEZVEDL_TELEFON',
        };

        const outcomeMap: Record<string, AICallOutcome> = {
            interested: 'CHCE_KONTAKT_AI',
            not_interested: 'NEKONTAKTOVAT',
            callback: 'ODKLADA',
            aggressive: 'NEKONTAKTOVAT',
            already_vodafone: 'NEKONTAKTOVAT',
            wrong_person: 'NEKONTAKTOVAT',
            no_answer: 'NEZVEDL_TELEFON',
        };

        const newStatus = statusMap[outcome.outcome];
        const callOutcome = outcomeMap[outcome.outcome];
        const aiAgentId = process.env.AI_AGENT_USER_ID;

        await pool.query(
            `UPDATE leads SET status = $1, ai_call_status = 'completed', updated_at = NOW() WHERE id = $2`,
            [newStatus, leadId]
        );

        await pool.query(
            `UPDATE ai_call_logs
             SET status = 'completed', outcome = $1, duration = $2, transcript = $3, ai_notes = $4, completed_at = NOW()
             WHERE call_sid = $5`,
            [callOutcome, Math.round(duration), transcript || outcome.transcript, outcome.aiNotes, callSid]
        );

        await pool.query(
            `INSERT INTO lead_comments (lead_id, user_id, old_status, new_status, comment)
             VALUES ($1, $2, 'NOVY', $3, $4)`,
            [leadId, aiAgentId, newStatus, `🤖 AI hovor dokončen\nVýsledek: ${callOutcome}\nDélka: ${Math.round(duration)}s\n${outcome.aiNotes}`]
        );

        console.log('✅ Lead updated after call:', { leadId, newStatus, outcome: callOutcome });
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

export const callOrchestrator = new CallOrchestrator();