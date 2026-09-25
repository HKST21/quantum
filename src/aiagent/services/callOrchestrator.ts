// ============================================
// CALL ORCHESTRATOR — QUANTUM CRM
// ============================================

import pool from '../../db/pool';
import { twilioService } from './twilioService';
import { odorikService } from './odorikService';
import { callHandler } from '../websockets/callHandler';
import { geminiCallHandler } from '../websockets/geminiCallHandler';
import { AICallOutcome, ConversationOutcome, CallEngine, CallProvider, OdorikLine } from '../types/aiCalls.types';

const POST_MORTEM_WAIT_ATTEMPTS = 4;
const POST_MORTEM_WAIT_INTERVAL_MS = 1500;

const ODORIK_PROPAGATION_DELAY_MS = 1500;
const ODORIK_MIN_INTER_CALL_DELAY_MS = 10_000;
const ODORIK_MAX_INTER_CALL_DELAY_MS = 18_000;

export class CallOrchestrator {

    async getLeadsForCalling(agentUserId: string, limit: number = 50): Promise<any[]> {
        try {
            const result = await pool.query(
                `SELECT id, company_name, contact_person, phone, email
                 FROM leads
                 WHERE status = 'NOVY'
                 AND assigned_to = $1
                 AND (ai_call_status IS NULL OR ai_call_status = 'failed')
                 ORDER BY created_at ASC
                 LIMIT $2`,
                [agentUserId, limit]
            );

            console.log(`✅ Found ${result.rows.length} leads ready for calling (agent: ${agentUserId})`);
            return result.rows;
        } catch (error) {
            console.error('❌ Failed to fetch leads for calling:', error);
            throw error;
        }
    }

    /**
     * Process a single lead call
     * @param leadId - UUID leadu
     * @param agentUserId - UUID agenta (pro výběr promptu, OpenAI i Gemini)
     * @param engine - 'openai' | 'gemini' (default: 'openai')
     * @param provider - 'twilio' | 'odorik' (default: 'twilio')
     * @param fromNumberOrSipName - pro provider='twilio': AI_PHONE_X
     *   přidělené workerovi. Pro provider='odorik': SIP jméno přidělené
     *   workerovi/identitě.
     * @param odorikLine - 'mobilni' (790766, default) | 'pevna' (793305)
     *   | 'fb' (7 linek). Relevantní jen když provider='odorik' —
     *   určuje, jaké "from" CLIP se použije, POKUD není zadané
     *   explicitFromNumber (viz níže).
     * @param explicitFromNumber - ⚠️ NOVÉ (24.9.2026). Pokud je zadané,
     *   PŘEBÍJÍ odvození CLIP z odorikLine — použije se přesně tahle
     *   hodnota jako Twilio "from". Určeno pro FB/rotující mód, kde
     *   každá identita (SIP jméno) má VLASTNÍ CLIP, ne sdílené jedno
     *   pro celou skupinu. Když NENÍ zadané (mobilní/pevná linka,
     *   parallel mód, beze změny), chování je identické jako dosud —
     *   CLIP se odvodí z odorikLine přes getPhoneNumberForLine().
     */
    async processLead(
        leadId: string,
        agentUserId: string,
        engine: CallEngine = 'openai',
        provider: CallProvider = 'twilio',
        fromNumberOrSipName?: string,
        odorikLine: OdorikLine = 'mobilni',
        explicitFromNumber?: string
    ): Promise<void> {
        let callSid: string | null = null;
        const isGeminiEngine = engine === 'gemini';
        const isOdorikProvider = provider === 'odorik';
        let sipNameUsed: string | null = null;

        try {
            console.log(`🎯 Processing lead: ${leadId} (agent: ${agentUserId}, engine: ${engine}, provider: ${provider}${isOdorikProvider ? `, linka: ${odorikLine}` : ''}${fromNumberOrSipName ? `, from/sip: ${fromNumberOrSipName}` : ''}${explicitFromNumber ? `, explicitFrom: ${explicitFromNumber}` : ''})`);

            const leadResult = await pool.query(
                `SELECT id, company_name, contact_person, phone, email FROM leads WHERE id = $1`,
                [leadId]
            );

            if (leadResult.rows.length === 0) throw new Error(`Lead ${leadId} not found`);

            const lead = leadResult.rows[0];

            console.log('📞 Calling lead:', { id: lead.id, company: lead.company_name, phone: lead.phone, engine, provider });

            await pool.query(
                `UPDATE leads
                 SET ai_call_status = 'calling', ai_last_call_at = NOW(),
                     ai_call_attempts = COALESCE(ai_call_attempts, 0) + 1, updated_at = NOW()
                 WHERE id = $1`,
                [leadId]
            );

            let destinationForTwilio: string;
            let callerNumber: string;

            if (isOdorikProvider) {
                const sipName = fromNumberOrSipName;
                if (!sipName) {
                    throw new Error('SIP jméno nebylo předáno pro Odorik provider (fromNumberOrSipName)');
                }

                console.log(`📡 Odorik SIP jméno: ${sipName} (linka: ${odorikLine}) → nastavuji přesměrování na ${lead.phone}`);
                await odorikService.setForward(sipName, lead.phone);
                sipNameUsed = sipName;

                console.log(`⏳ [Odorik] Čekám ${ODORIK_PROPAGATION_DELAY_MS}ms na propagaci routy...`);
                await this.sleep(ODORIK_PROPAGATION_DELAY_MS);

                destinationForTwilio = `sip:${sipName}@sip.odorik.cz`;

                // ⚠️ NOVÉ (24.9.2026) — explicitFromNumber má přednost
                // (FB/rotující mód, kde každá identita má vlastní CLIP).
                // Když není zadané, beze změny odvoď z odorikLine
                // (mobilní/pevná, parallel mód).
                callerNumber = explicitFromNumber || odorikService.getPhoneNumberForLine(odorikLine);

                if (!callerNumber) {
                    throw new Error(`Odorik CLIP číslo není k dispozici (odorikLine=${odorikLine}, explicitFromNumber=${explicitFromNumber || 'nezadáno'})`);
                }
            } else {
                destinationForTwilio = lead.phone;
                callerNumber = fromNumberOrSipName || process.env.TWILIO_PHONE_NUMBER || '';
            }

            console.log(`📞 Calling from: ${callerNumber} (engine: ${engine}, provider: ${provider})`);

            const callResponse = await twilioService.initiateCall(destinationForTwilio, leadId, callerNumber);
            callSid = callResponse.sid;

            console.log('✅ Twilio call initiated:', callSid);

            await pool.query(
                `INSERT INTO ai_call_logs (lead_id, call_sid, status, started_at, engine) VALUES ($1, $2, 'calling', NOW(), $3)`,
                [leadId, callSid, engine]
            );

            if (isGeminiEngine) {
                geminiCallHandler.setAgentForCall(callSid, agentUserId);
            } else {
                callHandler.setAgentForCall(callSid, agentUserId);
            }

            const maxWaitTime = 90000;
            const pollInterval = 2000;
            let elapsed = 0;

            while (elapsed < maxWaitTime) {
                await this.sleep(pollInterval);
                elapsed += pollInterval;

                const callData = isGeminiEngine
                    ? geminiCallHandler.getCallData(callSid)
                    : callHandler.getCallData(callSid);

                if (callData && callData.outcome) {
                    console.log('✅ Call completed with outcome:', callData.outcome);
                    const adaptedOutcome: ConversationOutcome = isGeminiEngine
                        ? this.adaptGeminiOutcome(callData.outcome as any)
                        : (callData.outcome as ConversationOutcome);
                    await this.updateLeadAfterCall(leadId, callSid, adaptedOutcome, callData.transcript, elapsed / 1000, agentUserId);
                    return;
                }

                const twilioStatus = await twilioService.getCallStatus(callSid);

                if (['completed', 'failed', 'busy', 'no-answer'].includes(twilioStatus.status)) {
                    console.log('📞 Twilio call ended:', twilioStatus.status);

                    if (isGeminiEngine && geminiCallHandler.isAwaitingFinalOutcome(callSid)) {
                        console.log('🪦 Post-mortem in flight — čekám na finální outcome před fallbackem:', callSid);
                        for (let attempt = 0; attempt < POST_MORTEM_WAIT_ATTEMPTS; attempt++) {
                            await this.sleep(POST_MORTEM_WAIT_INTERVAL_MS);
                            const lateData = geminiCallHandler.getCallData(callSid);
                            if (lateData?.outcome) break;
                            if (!geminiCallHandler.isAwaitingFinalOutcome(callSid)) break;
                        }
                    }

                    if (isGeminiEngine) {
                        const finalData = geminiCallHandler.getCallData(callSid);
                        if (finalData?.outcome) {
                            console.log('✅ Call completed with outcome (po zavěšení):', finalData.outcome);
                            const adaptedOutcome = this.adaptGeminiOutcome(finalData.outcome);
                            await this.updateLeadAfterCall(
                                leadId, callSid, adaptedOutcome, finalData.transcript,
                                twilioStatus.duration || elapsed / 1000, agentUserId
                            );
                            return;
                        }
                    }

                    const isPickedUpNoOutcome = twilioStatus.status === 'completed' && (twilioStatus.duration || 0) > 0;

                    await this.updateLeadAfterCall(
                        leadId, callSid,
                        isPickedUpNoOutcome
                            ? { outcome: 'hung_up', transcript: '', aiNotes: `Zákazník zvedl a zavěsil bez AI outcome (Twilio: ${twilioStatus.status})`, duration: 0, confidence: 1.0 }
                            : { outcome: 'no_answer', transcript: '', aiNotes: `Call ended: ${twilioStatus.status}`, duration: 0, confidence: 1.0 },
                        `Call ended: ${twilioStatus.status}`,
                        twilioStatus.duration || elapsed / 1000,
                        agentUserId
                    );
                    return;
                }
            }

            console.warn('⏰ Call timeout reached');
            if (isGeminiEngine) {
                geminiCallHandler.forceCleanup(callSid);
            } else {
                callHandler.forceCleanup(callSid);
            }
            await this.updateLeadAfterCall(
                leadId, callSid,
                { outcome: 'no_answer', transcript: '', aiNotes: 'Call timeout (90s)', duration: 90, confidence: 1.0 },
                'Call timeout',
                maxWaitTime / 1000,
                agentUserId
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
        } finally {
            if (isOdorikProvider && sipNameUsed) {
                const delayMs = ODORIK_MIN_INTER_CALL_DELAY_MS
                    + Math.random() * (ODORIK_MAX_INTER_CALL_DELAY_MS - ODORIK_MIN_INTER_CALL_DELAY_MS);
                console.log(`⏸️ [Odorik] Pauza před dalším hovorem: ${Math.round(delayMs / 1000)}s`);
                await this.sleep(delayMs);
            }
        }
    }

    private adaptGeminiOutcome(geminiOutcome: { outcome: string; reason: string; confidence: number; viaPostMortem?: boolean }): ConversationOutcome {
        const rawOutcome = (geminiOutcome.outcome === 'no_answer' && geminiOutcome.viaPostMortem === true)
            ? 'hung_up'
            : geminiOutcome.outcome;
        return {
            outcome: rawOutcome as ConversationOutcome['outcome'],
            transcript: '',
            aiNotes: geminiOutcome.reason,
            duration: 0,
            confidence: geminiOutcome.confidence,
        };
    }

    private async updateLeadAfterCall(
        leadId: string,
        callSid: string,
        outcome: ConversationOutcome,
        transcript: string,
        duration: number,
        agentUserId: string
    ): Promise<void> {
        const statusMap: Record<string, string> = {
            interested: 'CHCE_KONTAKT_AI',
            not_interested: 'ODMITNUTO',
            callback: 'ODKLADA',
            aggressive: 'NEKONTAKTOVAT',
            already_tmobile: 'NEKONTAKTOVAT',
            wrong_person: 'NEKONTAKTOVAT',
            no_answer: 'NEZVEDL_TELEFON',
            hung_up: 'POLOZIL_TELEFON',
        };

        const outcomeMap: Record<string, AICallOutcome> = {
            interested: 'CHCE_KONTAKT_AI',
            not_interested: 'NEKONTAKTOVAT',
            callback: 'ODKLADA',
            aggressive: 'NEKONTAKTOVAT',
            already_tmobile: 'NEKONTAKTOVAT',
            wrong_person: 'NEKONTAKTOVAT',
            no_answer: 'NEZVEDL_TELEFON',
            hung_up: 'POLOZIL_TELEFON',
        };

        const newStatus = statusMap[outcome.outcome];
        const callOutcome = outcomeMap[outcome.outcome];

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
            [leadId, agentUserId, newStatus, `🤖 AI hovor dokončen\nVýsledek: ${callOutcome}\nDélka: ${Math.round(duration)}s\n${outcome.aiNotes}`]
        );

        console.log('✅ Lead updated after call:', { leadId, newStatus, outcome: callOutcome });
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

export const callOrchestrator = new CallOrchestrator();