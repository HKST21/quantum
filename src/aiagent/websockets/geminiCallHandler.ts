// ============================================
// GEMINI CALL HANDLER — QUANTUM CRM
// WebSocket bridge: Twilio Media Streams ↔ Gemini Live API
// Audio konverze: µ-law 8kHz ↔ PCM16 24kHz
//
// ⚠️ NOVÉ (17.8.2026) — PREWARM MECHANISMUS (jen Gemini, OpenAI
// callHandler.ts se vůbec nemění):
//   prewarmCall() se volá z aiCalls.controller.ts (handleStatusCallback)
//   při Twilio 'ringing' eventu — založí Gemini session s odloženým
//   kick-startem (deferKickstart: true) a uloží ji do pendingCalls.
//   Když zákazník reálně zvedne, handleConnection() zkontroluje
//   pendingCalls PŘED založením nové session — pokud tam prewarmovaná
//   session je a je ready, znovupoužije ji (attach Twilio strany +
//   triggerKickstart()) místo zakládání od nuly. Pokud prewarm
//   neproběhl / selhal / není ready, spadne to na STANDARDNÍ cestu
//   (přesně stejné chování jako dřív) — prewarm je čistě optimalizace,
//   nikdy tvrdá závislost.
// ============================================

import WebSocket from 'ws';
import { GeminiService, GeminiOutcome } from '../services/geminiService';
import { geminiToTwilio, splitIntoFrames } from '../services/audioConverter';

const COMPLETED_TTL_MS = 10 * 60 * 1000;
const POST_MORTEM_TIMEOUT_MS = 5000;

// ⚠️ NOVÉ (17.8.2026) — max doba, po kterou čekáme na zvednutí po
// prewarmu, než pendingCall sám sebe uklidí. Mírně nad Twilio ring
// timeoutem (50s, viz twilioService.initiateCall `timeout: 50`), ať
// nikdy neuklidíme dřív, než Twilio sám vzdá vyzvánění.
const PENDING_CALL_MAX_WAIT_MS = 55000;

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

// ⚠️ NOVÉ (17.8.2026) — session čekající na zvednutí po prewarmu.
interface PendingCall {
    geminiService: GeminiService;
    leadId: string;
    ttlHandle: NodeJS.Timeout;
}

export class GeminiCallHandler {
    private activeCalls: Map<string, ActiveCall> = new Map();
    private completedCalls: Map<string, CompletedCall> = new Map();
    private pendingCalls: Map<string, PendingCall> = new Map();

    private agentMap: Map<string, string> = new Map();

    setAgentForCall(callSid: string, agentUserId: string): void {
        this.agentMap.set(callSid, agentUserId);
        console.log(`🤖 [Gemini] Agent set for call ${callSid}: ${agentUserId}`);
    }

    /**
     * ⚠️ NOVÉ (17.8.2026) — volá se z aiCalls.controller.ts při Twilio
     * 'ringing' eventu. Založí Gemini session s odloženým kick-startem
     * (setup proběhne, ale Eva nezačne mluvit) a uloží do pendingCalls.
     * Když zákazník zvedne, handleConnection() ji najde a znovupoužije.
     * Pokud hovor nikdo nezvedne, TTL v pendingCalls session sama uklidí.
     *
     * Idempotentní — pokud už pro tenhle callSid pending nebo aktivní
     * session existuje, nic dalšího nedělá.
     */
    async prewarmCall(
        callSid: string,
        leadId: string,
        agentUserId: string | undefined,
        leadData: { companyName: string; contactPerson: string; phone: string }
    ): Promise<void> {
        if (this.pendingCalls.has(callSid) || this.activeCalls.has(callSid)) {
            return;
        }

        console.log(`🛫 [Gemini] Prewarm started (ringing): ${callSid} | lead: ${leadId} | agent: ${agentUserId || 'default'}`);
        console.log(`⏱️ [TIMING] ${Date.now()} | prewarm start | ${callSid}`);

        const geminiService = new GeminiService();
        geminiService.callTag = callSid.slice(-6);

        const ttlHandle = setTimeout(() => {
            console.log(`🛬 [Gemini] Prewarm vypršel bez zvednutí (${PENDING_CALL_MAX_WAIT_MS}ms): ${callSid}`);
            this.cleanupPending(callSid);
        }, PENDING_CALL_MAX_WAIT_MS);
        ttlHandle.unref?.();

        this.pendingCalls.set(callSid, { geminiService, leadId, ttlHandle });

        try {
            await geminiService.createSession(leadData, agentUserId, { deferKickstart: true });
            console.log(`✅ [Gemini] Prewarm session ready (čeká na zvednutí): ${callSid}`);
            console.log(`⏱️ [TIMING] ${Date.now()} | prewarm setupComplete | ${callSid}`);
        } catch (error) {
            console.error(`❌ [Gemini] Prewarm selhal pro ${callSid}:`, error);
            this.cleanupPending(callSid);
        }
    }

    private cleanupPending(callSid: string): void {
        const pending = this.pendingCalls.get(callSid);
        if (!pending) return;
        clearTimeout(pending.ttlHandle);
        pending.geminiService.closeSession();
        this.pendingCalls.delete(callSid);
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

        // ⚠️ NOVÉ (17.8.2026) — zkontroluj, jestli neexistuje prewarmovaná
        // session z 'ringing' eventu.
        const pending = this.pendingCalls.get(callSid);
        if (pending) {
            this.pendingCalls.delete(callSid);
            clearTimeout(pending.ttlHandle);

            if (pending.geminiService.isSessionReady()) {
                console.log(`🔥 [Gemini] Reusing prewarmed session (šetří latenci prvního turnu): ${callSid}`);
                console.log(`⏱️ [TIMING] ${Date.now()} | reusing prewarmed session | ${callSid}`);
                this.activate(pending.geminiService, twilioWs, callSid, leadId, streamSid);
                this.setupTwilioHandlers(callSid);
                pending.geminiService.triggerKickstart();
                console.log(`✅ [Gemini] Call handler ready (prewarm): ${callSid}`);
                return;
            }

            console.warn(`⚠️ [Gemini] Prewarmovaná session nebyla ready, zakládám novou: ${callSid}`);
            pending.geminiService.closeSession();
        }

        // ── STANDARDNÍ CESTA — beze změny oproti dřívějšku. Buď žádný
        // prewarm neproběhl (Twilio 'ringing' event nedorazil / nestihl
        // se / nebyl to Gemini engine v tu chvíli), nebo prewarm selhal.
        try {
            const geminiService = new GeminiService();
            geminiService.callTag = callSid.slice(-6);

            this.activate(geminiService, twilioWs, callSid, leadId, streamSid);

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

    /**
     * Vytvoří ActiveCall záznam + timery + callbacky na geminiService.
     * Používá jak standardní, tak prewarm-reuse cesta v handleConnection.
     * NEVOLÁ setupTwilioHandlers — to zůstává na volajícím, kvůli
     * zachování přesného pořadí operací ve standardní cestě (Twilio
     * handlery se tam wirují až PO dokončení createSession, stejně
     * jako dřív).
     */
    private activate(
        geminiService: GeminiService,
        twilioWs: WebSocket,
        callSid: string,
        leadId: string,
        streamSid: string | null
    ): void {
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
        // ⚠️ NOVÉ (17.8.2026) — pokud se force-cleanup zavolá na hovor,
        // který je pořád jen v pendingCalls (nikdy nebyl zvednut, ale
        // callOrchestrator dřív vzdal čekání), uklidit i tam.
        if (this.pendingCalls.has(callSid)) {
            this.cleanupPending(callSid);
        }
        this.cleanupCall(callSid);
    }
}

export const geminiCallHandler = new GeminiCallHandler();