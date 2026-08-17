// ============================================
// GEMINI CALL HANDLER — QUANTUM CRM
// WebSocket bridge: Twilio Media Streams ↔ Gemini Live API
// Audio konverze: µ-law 8kHz ↔ PCM16 24kHz
//
// Mechanika (kick-start clearTimeout fix, race-condition fix přes
// completedCalls TTL snapshot, posmrtné vyhodnocení po zavěšení,
// isAwaitingFinalOutcome() dotaz pro orchestrátor) je převzatá 1:1
// z ověřené VF-CRM implementace.
//
// ⚠️ JEDINÝ věcný rozdíl oproti VF-CRM verzi: přidaný agentMap +
// setAgentForCall(), analogicky k tomu, jak to dělá Quantum vlastní
// (OpenAI) callHandler.ts. Quantum má per-agent Eva prompty (zatím jen
// v5, ale mapa je připravená na rozšíření), takže handleConnection
// potřebuje vědět, pro kterého agenta session vytváří.
// ============================================

import WebSocket from 'ws';
import { GeminiService, GeminiOutcome } from '../services/geminiService';
import { geminiToTwilio, splitIntoFrames } from '../services/audioConverter';

const COMPLETED_TTL_MS = 10 * 60 * 1000;
const POST_MORTEM_TIMEOUT_MS = 5000;

interface ActiveCall {
    twilioWs: WebSocket;
    geminiService: GeminiService;
    streamSid: string | null;
    callSid: string;
    leadId: string;
    transcript: string[];
    outcome: GeminiOutcome | null;
    monitoringActive: boolean;
    outputBuffer: Buffer;
    timingFirstTwilioMediaLogged?: boolean;
    timingFirstGeminiAudioLogged?: boolean;
    gracefulTimeout?: NodeJS.Timeout;
    fallbackTimeout?: NodeJS.Timeout;
    forceEndTimeout?: NodeJS.Timeout;
    postMortemActive?: boolean;
    postMortemTimeout?: NodeJS.Timeout;
}

interface CompletedCall {
    transcript: string;
    outcome: GeminiOutcome | null;
    ttlHandle: NodeJS.Timeout;
    wasPostMortem: boolean;
}

export class GeminiCallHandler {
    private activeCalls: Map<string, ActiveCall> = new Map();
    private completedCalls: Map<string, CompletedCall> = new Map();

    // ── NOVÉ oproti VF-CRM: agentUserId per callSid, analogie k
    // callHandler.ts (OpenAI) agentMap. Nastavuje callOrchestrator PŘED
    // tím, než Twilio pošle 'start' event.
    private agentMap: Map<string, string> = new Map();

    setAgentForCall(callSid: string, agentUserId: string): void {
        this.agentMap.set(callSid, agentUserId);
        console.log(`🤖 [Gemini] Agent set for call ${callSid}: ${agentUserId}`);
    }

    async handleConnection(
        twilioWs: WebSocket,
        callSid: string,
        leadId: string,
        leadData: { companyName: string; contactPerson: string; phone: string },
        streamSid: string | null
    ): Promise<void> {
        console.log(`📞 [Gemini] New call: ${callSid} | lead: ${leadId}`);
        console.log(`⏱️ [TIMING] ${Date.now()} | handleConnection start | ${callSid}`);

        const agentUserId = this.agentMap.get(callSid);
        this.agentMap.delete(callSid);

        try {
            const geminiService = new GeminiService();
            geminiService.callTag = callSid.slice(-6);

            const call: ActiveCall = {
                twilioWs,
                geminiService,
                streamSid,
                callSid,
                leadId,
                transcript: [],
                outcome: null,
                monitoringActive: false,
                outputBuffer: Buffer.alloc(0),
            };

            this.activeCalls.set(callSid, call);

            call.forceEndTimeout = setTimeout(() => {
                console.warn(`⏰ [Gemini] Force end after 120s: ${callSid}`);
                this.cleanupCall(callSid);
            }, 120000);

            geminiService.onAudioOutput = (pcm24kBuffer: Buffer) => {
                this.handleGeminiAudio(callSid, pcm24kBuffer);
            };

            geminiService.onOutcome = (outcome: GeminiOutcome) => {
                const c = this.activeCalls.get(callSid);
                if (!c) {
                    const done = this.completedCalls.get(callSid);
                    if (done) {
                        console.log(`✅ [Gemini] Late outcome after cleanup: ${outcome.outcome} (${callSid}, wasPostMortem: ${done.wasPostMortem})`);
                        done.outcome = { ...outcome, viaPostMortem: done.wasPostMortem };
                    }
                    return;
                }

                const viaPostMortem = !!c.postMortemActive;
                const taggedOutcome: GeminiOutcome = { ...outcome, viaPostMortem };

                console.log(`✅ [Gemini] Outcome: ${outcome.outcome} (confidence: ${outcome.confidence}, viaPostMortem: ${viaPostMortem})`);
                c.outcome = taggedOutcome;

                if (viaPostMortem) {
                    console.log(`🪦 [Gemini] Post-mortem outcome received: ${outcome.outcome} (${callSid})`);
                    if (c.postMortemTimeout) {
                        clearTimeout(c.postMortemTimeout);
                        c.postMortemTimeout = undefined;
                    }
                    this.cleanupCall(callSid);
                    return;
                }

                c.monitoringActive = true;

                c.fallbackTimeout = setTimeout(() => {
                    if (this.activeCalls.has(callSid)) {
                        console.log('⏰ [Gemini] Fallback timeout → cleanup');
                        this.cleanupCall(callSid);
                    }
                }, 10000);
            };

            geminiService.onTranscript = (text: string, role: 'user' | 'model') => {
                const c = this.activeCalls.get(callSid);
                if (!c) return;
                c.transcript.push(`${role === 'model' ? 'AI' : 'User'}: ${text}`);
            };

            geminiService.onClose = () => {
                console.log(`🔌 [Gemini] Gemini WS closed for: ${callSid}`);
                this.cleanupCall(callSid);
            };

            geminiService.onError = (err) => {
                console.error(`❌ [Gemini] Error for: ${callSid}`, err);
                setTimeout(() => this.cleanupCall(callSid), 3000);
            };

            console.log(`⏱️ [TIMING] ${Date.now()} | before createSession | ${callSid}`);
            await geminiService.createSession(leadData, agentUserId);
            console.log(`⏱️ [TIMING] ${Date.now()} | after createSession (setupComplete) | ${callSid}`);

            this.setupTwilioHandlers(callSid);

            console.log(`✅ [Gemini] Call handler ready: ${callSid}`);

        } catch (error) {
            console.error(`❌ [Gemini] Failed to init call handler:`, error);
            twilioWs.close();
        }
    }

    private handleGeminiAudio(callSid: string, pcm24kBuffer: Buffer): void {
        const call = this.activeCalls.get(callSid);
        if (!call?.streamSid) return;

        if (!call.timingFirstGeminiAudioLogged) {
            call.timingFirstGeminiAudioLogged = true;
            console.log(`⏱️ [TIMING] ${Date.now()} | first Gemini audio output | ${callSid}`);
        }

        const mulawBuffer = geminiToTwilio(pcm24kBuffer);
        call.outputBuffer = Buffer.concat([call.outputBuffer, mulawBuffer]);

        const frames = splitIntoFrames(call.outputBuffer);
        const totalFrameBytes = frames.length * 160;
        call.outputBuffer = call.outputBuffer.slice(totalFrameBytes);

        for (const frame of frames) {
            this.sendAudioToTwilio(callSid, frame);
        }

        // clearTimeout před novým nastavením — graceful end se posouvá
        // s posledním audio chunkem a vystřelí přesně jednou.
        if (call.monitoringActive) {
            if (call.fallbackTimeout) {
                clearTimeout(call.fallbackTimeout);
                call.fallbackTimeout = undefined;
            }
            if (call.gracefulTimeout) {
                clearTimeout(call.gracefulTimeout);
                call.gracefulTimeout = undefined;
            }
            call.gracefulTimeout = setTimeout(() => {
                console.log(`🛑 [Gemini] Graceful end: ${callSid}`);
                this.cleanupCall(callSid);
            }, 3000);
        }
    }

    private handleTwilioEnd(callSid: string, source: string): void {
        const call = this.activeCalls.get(callSid);
        if (!call) return;

        if (call.postMortemActive) {
            return;
        }

        const hasConversation = call.transcript.length > 0;
        const sessionAlive = call.geminiService.isSessionReady();

        if (call.outcome || !hasConversation || !sessionAlive) {
            this.cleanupCall(callSid);
            return;
        }

        const sent = call.geminiService.requestFinalOutcome();
        if (!sent) {
            this.cleanupCall(callSid);
            return;
        }

        call.postMortemActive = true;
        console.log(`🪦 [Gemini] Post-mortem requested (${source}): ${callSid} — čekám max ${POST_MORTEM_TIMEOUT_MS}ms na finální outcome`);

        call.postMortemTimeout = setTimeout(() => {
            const c = this.activeCalls.get(callSid);
            if (c) {
                console.log(`🪦 [Gemini] Post-mortem timeout — žádný outcome nepřišel: ${callSid}`);
                this.cleanupCall(callSid);
            }
        }, POST_MORTEM_TIMEOUT_MS);
    }

    private setupTwilioHandlers(callSid: string): void {
        const call = this.activeCalls.get(callSid);
        if (!call) return;

        call.twilioWs.on('message', (message: string) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'start':
                        console.log(`📞 [Gemini] Twilio stream started: ${data.start.streamSid}`);
                        const c = this.activeCalls.get(callSid);
                        if (c) {
                            c.streamSid = data.start.streamSid;
                            this.activeCalls.set(callSid, c);
                        }
                        break;

                    case 'media':
                        if (data.media?.payload) {
                            if (!call.timingFirstTwilioMediaLogged) {
                                call.timingFirstTwilioMediaLogged = true;
                                console.log(`⏱️ [TIMING] ${Date.now()} | first Twilio media chunk received | ${callSid}`);
                            }
                            const mulawBuffer = Buffer.from(data.media.payload, 'base64');
                            call.geminiService.sendAudio(mulawBuffer);
                        }
                        break;

                    case 'stop':
                        console.log(`📞 [Gemini] Twilio stream stopped: ${callSid}`);
                        this.handleTwilioEnd(callSid, 'stream stop');
                        break;
                }
            } catch (err) {
                console.error('❌ [Gemini] Twilio message error:', err);
            }
        });

        call.twilioWs.on('close', () => {
            console.log(`🔌 [Gemini] Twilio WS closed: ${callSid}`);
            this.handleTwilioEnd(callSid, 'ws close');
        });

        call.twilioWs.on('error', (err) => {
            console.error(`❌ [Gemini] Twilio WS error:`, err);
            this.cleanupCall(callSid);
        });
    }

    private sendAudioToTwilio(callSid: string, mulawFrame: Buffer): void {
        const call = this.activeCalls.get(callSid);
        if (!call?.streamSid) return;

        if (call.twilioWs.readyState !== WebSocket.OPEN) return;

        try {
            call.twilioWs.send(JSON.stringify({
                event: 'media',
                streamSid: call.streamSid,
                media: { payload: mulawFrame.toString('base64') },
            }));
        } catch (err) {
            console.error('❌ [Gemini] Failed to send audio to Twilio:', err);
        }
    }

    getCallData(callSid: string): { transcript: string; outcome: GeminiOutcome | null } | null {
        const call = this.activeCalls.get(callSid);
        if (call) {
            return {
                transcript: call.transcript.join('\n'),
                outcome: call.outcome,
            };
        }
        const done = this.completedCalls.get(callSid);
        if (done) {
            return {
                transcript: done.transcript,
                outcome: done.outcome,
            };
        }
        return null;
    }

    isAwaitingFinalOutcome(callSid: string): boolean {
        const call = this.activeCalls.get(callSid);
        return !!call?.postMortemActive;
    }

    private cleanupCall(callSid: string): void {
        const call = this.activeCalls.get(callSid);
        if (!call) return;

        console.log(`🧹 [Gemini] Cleaning up: ${callSid}`);

        if (call.gracefulTimeout) clearTimeout(call.gracefulTimeout);
        if (call.fallbackTimeout) clearTimeout(call.fallbackTimeout);
        if (call.forceEndTimeout) clearTimeout(call.forceEndTimeout);
        if (call.postMortemTimeout) clearTimeout(call.postMortemTimeout);

        const existing = this.completedCalls.get(callSid);
        if (existing) {
            if (!existing.outcome && call.outcome) {
                existing.outcome = call.outcome;
            }
        } else {
            const ttlHandle = setTimeout(() => {
                this.completedCalls.delete(callSid);
            }, COMPLETED_TTL_MS);
            ttlHandle.unref?.();
            this.completedCalls.set(callSid, {
                transcript: call.transcript.join('\n'),
                outcome: call.outcome,
                wasPostMortem: !!call.postMortemActive,
                ttlHandle,
            });
        }

        call.geminiService.closeSession();

        if (call.twilioWs.readyState === WebSocket.OPEN) {
            call.twilioWs.close();
        }

        this.activeCalls.delete(callSid);
        console.log(`✅ [Gemini] Cleanup complete: ${callSid}`);
    }

    forceCleanup(callSid: string): void {
        this.cleanupCall(callSid);
    }
}

export const geminiCallHandler = new GeminiCallHandler();