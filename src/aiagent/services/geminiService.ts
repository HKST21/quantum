// ============================================
// GEMINI LIVE API SERVICE — QUANTUM CRM
// Real-time voice session pro Gemini Live
// Model: gemini-3.1-flash-live-preview
// Audio: PCM16 16kHz input, PCM16 24kHz output
//
// ⚠️ NOVÉ (17.8.2026) — PREWARM PODPORA (jen pro Gemini, nedotýká se
// OpenAI cesty vůbec):
//   Session lze založit s options.deferKickstart=true — provede se
//   celý setup handshake (WS open, setup zpráva, setupComplete), ale
//   NEPOŠLE se automaticky kick-start. Volající (geminiCallHandler)
//   pak zavolá triggerKickstart() ve chvíli, kdy zákazník reálně
//   zvedne telefon. Cíl: přesunout nákladné/pomalé zpracování velkého
//   systémového promptu (typicky ~3s u prvního turnu na tomhle modelu
//   v telefonním nasazení) do doby vyzvánění, kdy na to zákazník ještě
//   nečeká — takže samotný kick-start turn po zvednutí je rychlejší.
//   Podle Live API dokumentace se účtuje za TURN, ne za otevřenou
//   session — dokud se neodešle kick-start, neproběhl žádný turn,
//   takže prewarm hovorů, které nikdo nezvedne, by neměl stát nic
//   navíc.
//
// ⚠️ NOVÉ (17.8.2026) — kvalitativní úpravy po analýze produkční dávky
// (viz starší komentáře v historii souboru): voice Zephyr→Vindemiatrix
// (Gentle), prefix_padding_ms 300→700, input suppression shield proti
// falešnému přerušení pozdravu, KICKSTART_DELAY_MS 1000→300 (shield
// teď řeší ochranu proti překryvu, takže není třeba čekat celou vteřinu
// před odesláním kick-startu).
//
// Jediné věcné rozdíly oproti VF-CRM verzi:
//   1) Prompt vychází z eva_v5 (T-Mobile), ne z Petra v2 (Vodafone).
//   2) Eva NENÍ personalizovaná jménem/firmou — buildPrompt() nebere
//      leadData args.
//   3) Výběr promptu podle agentUserId (GEMINI_AGENT_PROMPTS mapa).
//   4) GeminiOutcome enum používá 'already_tmobile' místo
//      'already_vodafone'.
// ============================================

import WebSocket from 'ws';
import { twilioToGemini } from './audioConverter';
import { evaV5GeminiPrompt } from '../prompts/eva_v5_gemini';

const GEMINI_MODEL = 'gemini-3.1-flash-live-preview';
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
const SETUP_TIMEOUT_MS = 15000;
const KICKSTART_DELAY_MS = 300;
const INPUT_SUPPRESSION_MAX_MS = 4000;

const GEMINI_AGENT_PROMPTS: Record<string, () => string> = {
    'ffbabfc8-08e0-4dae-8a02-f9d7865f2bd9': evaV5GeminiPrompt,
};

export interface GeminiOutcome {
    outcome: 'interested' | 'not_interested' | 'callback' | 'aggressive' | 'already_tmobile' | 'wrong_person' | 'no_answer';
    reason: string;
    confidence: number;
    viaPostMortem?: boolean;
}

export interface CreateSessionOptions {
    // ⚠️ NOVÉ (17.8.2026) — true = pošli setup, ale NEPOSÍLEJ kick-start
    // automaticky. Použij pro prewarm (session založená během vyzvánění,
    // ještě nevíme, jestli zákazník zvedne). Kick-start se pak spustí
    // explicitně přes triggerKickstart(), až/pokud zákazník zvedne.
    deferKickstart?: boolean;
}

export class GeminiService {
    private apiKey: string;
    private ws: WebSocket | null = null;
    private isReady: boolean = false;
    private audioQueue: Buffer[] = [];
    private setupTimeoutHandle: NodeJS.Timeout | null = null;
    private kickstartTimeoutHandle: NodeJS.Timeout | null = null;
    private timingFirstBufferLogged = false;
    private timingFirstSendLogged = false;

    private suppressInputUntilFirstAudio = false;
    private inputSuppressionTimeoutHandle: NodeJS.Timeout | null = null;

    // ⚠️ NOVÉ (17.8.2026) — prewarm stav
    private deferKickstart = false;
    private kickstartSent = false;

    callTag: string = '';

    onAudioOutput?: (pcm24kBuffer: Buffer) => void;
    onOutcome?: (outcome: GeminiOutcome) => void;
    onTranscript?: (text: string, role: 'user' | 'model') => void;
    onReady?: () => void;
    onClose?: () => void;
    onError?: (error: Error) => void;

    constructor() {
        this.apiKey = process.env.GOOGLE_API_KEY || '';
        if (!this.apiKey) throw new Error('GOOGLE_API_KEY not configured');
        console.log('✅ [Gemini] GeminiService initialized');
    }

    private getPromptForAgent(agentUserId?: string): string {
        const promptFn = agentUserId ? GEMINI_AGENT_PROMPTS[agentUserId] : undefined;
        if (!promptFn) {
            if (agentUserId) {
                console.warn(`⚠️ [Gemini] No Gemini prompt for agent ${agentUserId}, falling back to v5`);
            }
            return evaV5GeminiPrompt();
        }
        return promptFn();
    }

    private startInputSuppression(): void {
        this.suppressInputUntilFirstAudio = true;
        if (this.inputSuppressionTimeoutHandle) {
            clearTimeout(this.inputSuppressionTimeoutHandle);
        }
        this.inputSuppressionTimeoutHandle = setTimeout(() => {
            if (this.suppressInputUntilFirstAudio) {
                console.log(`⏱️ [Gemini${this.callTag ? ' ' + this.callTag : ''}] Input suppression shield: pojistka vypršela (${INPUT_SUPPRESSION_MAX_MS}ms) bez audia od Evy — obnovuji vstup`);
            }
            this.suppressInputUntilFirstAudio = false;
            this.inputSuppressionTimeoutHandle = null;
        }, INPUT_SUPPRESSION_MAX_MS);
        console.log(`🛡️ [Gemini${this.callTag ? ' ' + this.callTag : ''}] Input suppression shield aktivní (max ${INPUT_SUPPRESSION_MAX_MS}ms nebo do prvního audia)`);
    }

    private clearInputSuppression(): void {
        if (!this.suppressInputUntilFirstAudio && !this.inputSuppressionTimeoutHandle) return;
        this.suppressInputUntilFirstAudio = false;
        if (this.inputSuppressionTimeoutHandle) {
            clearTimeout(this.inputSuppressionTimeoutHandle);
            this.inputSuppressionTimeoutHandle = null;
        }
        console.log(`🛡️ [Gemini${this.callTag ? ' ' + this.callTag : ''}] Input suppression shield zrušen — první audio od Evy dorazilo`);
    }

    // ⚠️ NOVÉ (17.8.2026) — sjednocené odeslání kick-start zprávy,
    // používá jak automatický (non-prewarm) tak explicitní (prewarm
    // triggerKickstart) flow. Idempotentní — druhé volání je no-op.
    private sendKickstartNow(): void {
        if (this.kickstartSent) return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.log('⏭️ [Gemini] Kick-start skipped — WS už není otevřený');
            return;
        }
        this.kickstartSent = true;
        this.ws.send(JSON.stringify({
            clientContent: {
                turns: [{
                    role: 'user',
                    parts: [{ text: '(Zákazník právě zvedl telefon. Zahaj hovor podle FÁZE 1.)' }],
                }],
                turnComplete: true,
            },
        }));
        console.log(`⏱️ [TIMING] ${Date.now()} | kick-start clientContent sent | ${this.callTag}`);
        this.startInputSuppression();
    }

    /**
     * ⚠️ NOVÉ (17.8.2026) — explicitní spuštění kick-startu pro
     * prewarmovanou session (createSession volaná s deferKickstart:
     * true). Volá geminiCallHandler ve chvíli, kdy zákazník reálně
     * zvedne telefon (Twilio Media Stream se připojí). Idempotentní —
     * pokud už kick-start odešel nebo je naplánovaný, nic dalšího
     * nedělá.
     */
    triggerKickstart(): void {
        if (this.kickstartSent || this.kickstartTimeoutHandle) return;
        this.kickstartTimeoutHandle = setTimeout(() => {
            this.kickstartTimeoutHandle = null;
            this.sendKickstartNow();
        }, KICKSTART_DELAY_MS);
    }

    async createSession(
        _leadData: { companyName: string; contactPerson: string; phone: string },
        agentUserId?: string,
        options?: CreateSessionOptions
    ): Promise<void> {
        this.deferKickstart = !!options?.deferKickstart;

        return new Promise((resolve, reject) => {
            const url = `${GEMINI_WS_URL}?key=${this.apiKey}`;
            const prompt = this.getPromptForAgent(agentUserId);

            console.log(`🤖 [Gemini] Creating session (agent: ${agentUserId || 'default'}${this.deferKickstart ? ', PREWARM' : ''})`);

            this.ws = new WebSocket(url);

            this.setupTimeoutHandle = setTimeout(() => {
                console.error('❌ [Gemini] Setup timeout — žádná odpověď od Gemini do', SETUP_TIMEOUT_MS, 'ms');
                const err = new Error(`Gemini setup timeout after ${SETUP_TIMEOUT_MS}ms`);
                this.onError?.(err);
                this.closeSession();
                reject(err);
            }, SETUP_TIMEOUT_MS);

            this.ws.on('open', () => {
                console.log('✅ [Gemini] WebSocket connected');
                console.log(`⏱️ [TIMING] ${Date.now()} | Gemini WS open`);

                const setupMessage = {
                    setup: {
                        model: `models/${GEMINI_MODEL}`,
                        generation_config: {
                            response_modalities: ['AUDIO'],
                            speech_config: {
                                voice_config: {
                                    prebuilt_voice_config: {
                                        voice_name: 'Vindemiatrix',
                                    },
                                },
                                language_code: 'cs-CZ',
                            },
                            thinking_config: {
                                thinking_level: 'minimal',
                            },
                        },
                        realtime_input_config: {
                            automatic_activity_detection: {
                                start_of_speech_sensitivity: 'START_SENSITIVITY_HIGH',
                                end_of_speech_sensitivity: 'END_SENSITIVITY_HIGH',
                                prefix_padding_ms: 700,
                                silence_duration_ms: 600,
                            },
                        },
                        system_instruction: {
                            parts: [{ text: prompt }],
                        },
                        tools: [{
                            function_declarations: [{
                                name: 'end_call_with_outcome',
                                description: 'Zavolej tuto funkci když je hovor u konce. Zákazník nesmí nikdy slyšet název funkce. Volej až po dokončení své poslední věty.',
                                parameters: {
                                    type: 'OBJECT',
                                    properties: {
                                        outcome: {
                                            type: 'STRING',
                                            enum: ['interested', 'not_interested', 'callback', 'aggressive', 'already_tmobile', 'wrong_person', 'no_answer'],
                                            description: 'Výsledek hovoru',
                                        },
                                        confidence: {
                                            type: 'NUMBER',
                                            description: 'Míra jistoty 0-1',
                                        },
                                        reason: {
                                            type: 'STRING',
                                            description: 'Stručné vysvětlení výsledku v češtině. Pro interested: zahrň počet telefonních čísel.',
                                        },
                                    },
                                    required: ['outcome', 'confidence', 'reason'],
                                },
                            }],
                        }],
                    },
                };

                this.ws?.send(JSON.stringify(setupMessage));
                console.log('📤 [Gemini] Setup message sent (bez input_audio_config)');
            });

            this.ws.on('message', (raw: Buffer) => {
                try {
                    const msg = JSON.parse(raw.toString());

                    if (msg.setupComplete) {
                        console.log('✅ [Gemini] Session ready');
                        console.log(`⏱️ [TIMING] ${Date.now()} | setupComplete received | ${this.callTag}${this.deferKickstart ? ' (PREWARM, čeká na triggerKickstart)' : ''}`);
                        if (this.setupTimeoutHandle) {
                            clearTimeout(this.setupTimeoutHandle);
                            this.setupTimeoutHandle = null;
                        }
                        this.isReady = true;
                        this.flushAudioQueue();

                        // ⚠️ NOVÉ (17.8.2026) — u prewarmu se kick-start
                        // NESPOUŠTÍ automaticky, čeká se na explicitní
                        // triggerKickstart() z geminiCallHandler.
                        if (!this.deferKickstart) {
                            this.kickstartTimeoutHandle = setTimeout(() => {
                                this.kickstartTimeoutHandle = null;
                                this.sendKickstartNow();
                            }, KICKSTART_DELAY_MS);
                        }

                        this.onReady?.();
                        resolve();
                        return;
                    }

                    if (msg.error) {
                        const errMsg = typeof msg.error === 'string'
                            ? msg.error
                            : JSON.stringify(msg.error);
                        console.error('❌ [Gemini] Setup/session error from API:', errMsg);

                        if (!this.isReady) {
                            if (this.setupTimeoutHandle) {
                                clearTimeout(this.setupTimeoutHandle);
                                this.setupTimeoutHandle = null;
                            }
                            const err = new Error(`Gemini setup failed: ${errMsg}`);
                            this.onError?.(err);
                            reject(err);
                        } else {
                            this.onError?.(new Error(`Gemini runtime error: ${errMsg}`));
                        }
                        return;
                    }

                    if (msg.toolCall) {
                        const functionCalls = msg.toolCall.functionCalls || [];
                        for (const call of functionCalls) {
                            if (call.name === 'end_call_with_outcome') {
                                const args = call.args || {};
                                console.log(`🎯 [Gemini${this.callTag ? ' ' + this.callTag : ''}] Function call: ${JSON.stringify(args)}`);
                                this.onOutcome?.({
                                    outcome: args.outcome,
                                    reason: args.reason || '',
                                    confidence: args.confidence || 0.5,
                                });

                                this.ws?.send(JSON.stringify({
                                    toolResponse: {
                                        functionResponses: [{
                                            id: call.id,
                                            name: call.name,
                                            response: { result: 'ok' },
                                        }],
                                    },
                                }));
                            }
                        }
                    }

                    if (msg.serverContent?.modelTurn?.parts) {
                        for (const part of msg.serverContent.modelTurn.parts) {
                            if (part.inlineData?.mimeType?.includes('audio') && part.inlineData.data) {
                                if (this.suppressInputUntilFirstAudio) {
                                    this.clearInputSuppression();
                                }
                                const pcm24k = Buffer.from(part.inlineData.data, 'base64');
                                this.onAudioOutput?.(pcm24k);
                            }
                            if (part.text) {
                                this.onTranscript?.(part.text, 'model');
                                console.log(`🤖 [Gemini${this.callTag ? ' ' + this.callTag : ''}] AI: ${part.text}`);
                            }
                            if (part.functionCall?.name === 'end_call_with_outcome') {
                                const args = part.functionCall.args;
                                console.log(`🎯 [Gemini] Function call: ${JSON.stringify(args)}`);
                                this.onOutcome?.({
                                    outcome: args.outcome,
                                    reason: args.reason || '',
                                    confidence: args.confidence || 0.5,
                                });
                            }
                        }
                    }

                    if (msg.serverContent?.inputTranscription?.text) {
                        this.onTranscript?.(msg.serverContent.inputTranscription.text, 'user');
                        console.log(`👤 [Gemini${this.callTag ? ' ' + this.callTag : ''}] User: ${msg.serverContent.inputTranscription.text}`);
                    }

                    if (msg.serverContent?.turnComplete) {
                        console.log(`✅ [Gemini${this.callTag ? ' ' + this.callTag : ''}] Turn complete`);
                    }

                } catch (err) {
                    console.error('❌ [Gemini] Message parse error:', err);
                }
            });

            this.ws.on('error', (err) => {
                console.error('❌ [Gemini] WebSocket error:', err);
                if (this.setupTimeoutHandle) {
                    clearTimeout(this.setupTimeoutHandle);
                    this.setupTimeoutHandle = null;
                }
                this.onError?.(err);
                if (!this.isReady) reject(err);
            });

            this.ws.on('close', (code, reason) => {
                console.log(`🔌 [Gemini] WebSocket closed: ${code} ${reason}`);
                if (this.setupTimeoutHandle) {
                    clearTimeout(this.setupTimeoutHandle);
                    this.setupTimeoutHandle = null;
                }
                const wasReady = this.isReady;
                this.isReady = false;
                this.onClose?.();
                if (!wasReady) {
                    reject(new Error(`Gemini WebSocket closed before setup completed (code ${code})`));
                }
            });
        });
    }

    requestFinalOutcome(): boolean {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isReady) {
            return false;
        }
        this.ws.send(JSON.stringify({
            clientContent: {
                turns: [{
                    role: 'user',
                    parts: [{ text: '(Zákazník zavěsil. Hovor skončil. Nemluv — okamžitě zavolej end_call_with_outcome podle sekce ZÁKAZNÍK ZAVĚSIL: souhlas se zasláním ceníku → interested i bez počtu čísel; odmítnutí → not_interested; nejasný průběh → no_answer.)' }],
                }],
                turnComplete: true,
            },
        }));
        console.log(`🪦 [Gemini${this.callTag ? ' ' + this.callTag : ''}] Final outcome request sent (zákazník zavěsil)`);
        return true;
    }

    private flushAudioQueue(): void {
        if (this.audioQueue.length === 0) return;
        console.log(`🔄 [Gemini] Flushing ${this.audioQueue.length} buffered audio chunks`);
        for (const chunk of this.audioQueue) {
            this.sendAudio(chunk);
        }
        this.audioQueue = [];
    }

    sendAudio(mulawBuffer: Buffer): void {
        if (this.suppressInputUntilFirstAudio) {
            return;
        }

        if (!this.isReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            if (!this.timingFirstBufferLogged) {
                this.timingFirstBufferLogged = true;
                console.log(`⏱️ [TIMING] ${Date.now()} | first audio chunk BUFFERED (session not ready)`);
            }
            this.audioQueue.push(mulawBuffer);
            return;
        }

        if (!this.timingFirstSendLogged) {
            this.timingFirstSendLogged = true;
            console.log(`⏱️ [TIMING] ${Date.now()} | first audio chunk SENT to Gemini`);
        }

        const pcm16k = twilioToGemini(mulawBuffer);

        const audioMessage = {
            realtime_input: {
                audio: {
                    data: pcm16k.toString('base64'),
                    mime_type: 'audio/pcm;rate=16000',
                },
            },
        };

        this.ws.send(JSON.stringify(audioMessage));
    }

    closeSession(): void {
        if (this.setupTimeoutHandle) {
            clearTimeout(this.setupTimeoutHandle);
            this.setupTimeoutHandle = null;
        }
        if (this.kickstartTimeoutHandle) {
            clearTimeout(this.kickstartTimeoutHandle);
            this.kickstartTimeoutHandle = null;
        }
        if (this.inputSuppressionTimeoutHandle) {
            clearTimeout(this.inputSuppressionTimeoutHandle);
            this.inputSuppressionTimeoutHandle = null;
        }
        this.suppressInputUntilFirstAudio = false;
        if (this.ws) {
            console.log('🔌 [Gemini] Closing session...');
            this.isReady = false;
            this.audioQueue = [];
            this.ws.close();
            this.ws = null;
        }
    }

    isSessionReady(): boolean {
        return this.isReady;
    }
}