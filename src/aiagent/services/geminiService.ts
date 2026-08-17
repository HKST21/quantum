// ============================================
// GEMINI LIVE API SERVICE — QUANTUM CRM
// Real-time voice session pro Gemini Live
// Model: gemini-3.1-flash-live-preview
// Audio: PCM16 16kHz input, PCM16 24kHz output
//
// Mechanika (setup, kick-start, VAD tuning, setup timeout, error
// handling, requestFinalOutcome) je převzatá 1:1 z ověřené VF-CRM
// implementace — beze změny, protože jde o Gemini Live API chování
// nezávislé na obchodním obsahu.
//
// ⚠️ NOVÉ (17.8.2026) — dvě kvalitativní úpravy po analýze produkční
// dávky, kde se objevoval vysoký podíl POLOZIL_TELEFON s poznámkami
// typu "zavěsil uprostřed věty" / "zavěsil hned po pozdravu" / "uvedl,
// že mě neslyší a že jsem automat":
//
//   1) VOICE ZMĚNA: 'Zephyr' (charakteristika "Bright" — jasný,
//      energický, může znít útočně/naléhavě) → 'Achernar'
//      (charakteristika "Soft"). Obě jsou ženské hlasy, takže charakter
//      Evy zůstává stejný, jen měkčí tón.
//
//   2) INPUT SUPPRESSION SHIELD + prefix_padding_ms 300→700: řeší
//      zdokumentovaný bug u gemini-3.1-flash-live-preview v telefonním
//      nasazení (Twilio MediaStreams) — první "turn" (úvodní pozdrav)
//      trvá řádově 3s od zahájení generování po první audio chunk,
//      zatímco další turny jsou rychlé (~500ms). V té úvodní mezeře
//      zákazníkovo "Haló?" spustí VAD, který myslí, že ho zákazník
//      přerušil, a Gemini restartuje pozdrav od začátku — což zní jako
//      zaseknutí/opakování a zákazníka to zmate natolik, že zavěsí
//      nebo řekne "nerozumím vám" / "jste automat".
//      Řešení (odpovídá veřejně zdokumentovanému workaroundu pro
//      stejný model+scénář): od okamžiku odeslání kick-start instrukce
//      až do příchodu PRVNÍHO audio chunku od Gemini (s pojistkou
//      INPUT_SUPPRESSION_MAX_MS) se příchozí audio od zákazníka
//      ZAHAZUJE, ne posílá do Gemini — takže zákazníkovo "Haló?" v té
//      zranitelné mezeře nemá šanci spustit falešné přerušení. Jakmile
//      Eva reálně začne mluvit, shield se zruší a normální barge-in
//      (zákazník smí Evu přerušit) funguje jako dřív, beze změny.
//      prefix_padding_ms 700 (dřív 300) navíc filtruje krátké šumy na
//      telefonní lince i po zbytek hovoru, aby nespouštěly falešné
//      "start of speech" detekce.
//
// Jediné věcné rozdíly oproti VF-CRM verzi:
//   1) Prompt vychází z eva_v5 (T-Mobile), ne z Petra v2 (Vodafone).
//   2) Eva NENÍ personalizovaná jménem/firmou (stejně jako u OpenAI
//      verze v openAIService.ts) — buildPrompt() nebere leadData args.
//   3) Výběr promptu podle agentUserId (GEMINI_AGENT_PROMPTS mapa),
//      analogicky k AGENT_PROMPTS v openAIService.ts.
//   4) GeminiOutcome enum používá 'already_tmobile' místo
//      'already_vodafone' (a stejně tak function-call tool declarace).
//
// ⚠️ Historie oprav (převzato z VF-CRM, viz tamní geminiService.ts):
//   - input_audio_config se do `setup` NEPOSÍLÁ (Gemini to odmítá,
//     formát vstupu se určuje mime_type v realtime_input.audio).
//   - Setup timeout (15s) + error handling ve WS message handleru,
//     aby se createSession() Promise nikdy nezasekla bez reject/resolve.
//   - Tool/function call chodí jako top-level msg.toolCall.functionCalls[],
//     ne vnořené v serverContent.modelTurn.parts (starý dead-code blok
//     v parts smyčce se nechává jako neškodná záloha).
//   - Kick-start (1s prodleva po setupComplete): explicitní textový
//     user turn, ať Petra/Eva zahájí FÁZI 1 bez čekání na první
//     VAD-detekovaný turn (VAD turn thrashing bug na preview modelu).
//   - language_code: 'cs-CZ' v speech_config — zmírnění garbled
//     transkripcí v cizích jazycích.
//   - requestFinalOutcome() — "posmrtné vyhodnocení" po zavěšení
//     zákazníka, viz geminiCallHandler.ts.
// ============================================

import WebSocket from 'ws';
import { twilioToGemini } from './audioConverter';
import { evaV5GeminiPrompt } from '../prompts/eva_v5_gemini';

const GEMINI_MODEL = 'gemini-3.1-flash-live-preview';
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
const SETUP_TIMEOUT_MS = 15000; // pokud do 15s nepřijde setupComplete ani chyba, session se považuje za nezdařenou
const KICKSTART_DELAY_MS = 1000; // prodleva před kick-startem — dá zákazníkovi prostor doříct "haló" bez překryvu s Evou

// ⚠️ NOVÉ (17.8.2026) — max doba, po kterou se potlačuje vstupní audio
// od zákazníka po odeslání kick-startu, než reálně dorazí první audio
// chunk od Evy. Pojistka pro případ, že by Eva z nějakého důvodu
// nezačala mluvit vůbec (jinak by se vstup potlačoval navždy) — po
// uplynutí se shield zruší i bez audia.
const INPUT_SUPPRESSION_MAX_MS = 4000;

// ── Per-agent výběr Gemini promptu, analogie k AGENT_PROMPTS v
// openAIService.ts. Zatím jen v5; fallback na v5 i pro neznámé/
// nezadané agentUserId (viz getPromptForAgent níže).
const GEMINI_AGENT_PROMPTS: Record<string, () => string> = {
    'ffbabfc8-08e0-4dae-8a02-f9d7865f2bd9': evaV5GeminiPrompt, // stejné UUID jako v5 v openAIService.ts
};

export interface GeminiOutcome {
    outcome: 'interested' | 'not_interested' | 'callback' | 'aggressive' | 'already_tmobile' | 'wrong_person' | 'no_answer';
    reason: string;
    confidence: number;
    // Nastavuje VÝHRADNĚ geminiCallHandler.ts, ne tenhle soubor. True =
    // tenhle outcome je odpověď na posmrtnou žádost "(Zákazník zavěsil…)"
    // po fyzickém zavěšení zákazníka. Undefined/false = normální živý
    // outcome. Viz geminiCallHandler.ts a callOrchestrator.ts
    // (adaptGeminiOutcome / POLOZIL_TELEFON mapování).
    viaPostMortem?: boolean;
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

    // ⚠️ NOVÉ (17.8.2026) — input suppression shield stav. Viz hlavička
    // souboru. true = zahazuj příchozí audio od zákazníka (dokud
    // nedorazí první audio od Evy nebo nevyprší pojistka).
    private suppressInputUntilFirstAudio = false;
    private inputSuppressionTimeoutHandle: NodeJS.Timeout | null = null;

    // Krátký identifikátor hovoru pro transkripční logy — nastavuje ho
    // geminiCallHandler po vytvoření instance (posledních 6 znaků callSid).
    callTag: string = '';

    // Callbacky nastavené z geminiCallHandler
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

    // ⚠️ NOVÉ (17.8.2026) — zapne input suppression shield. Volá se
    // těsně po odeslání kick-start clientContent zprávy (viz
    // setupComplete handler níže). Pojistka INPUT_SUPPRESSION_MAX_MS
    // zajistí, že se shield vždy sám zruší, i kdyby Eva z nějakého
    // důvodu nikdy nezačala mluvit.
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

    // Zruší shield — volá se při příchodu prvního audio chunku od Evy.
    private clearInputSuppression(): void {
        if (!this.suppressInputUntilFirstAudio && !this.inputSuppressionTimeoutHandle) return;
        this.suppressInputUntilFirstAudio = false;
        if (this.inputSuppressionTimeoutHandle) {
            clearTimeout(this.inputSuppressionTimeoutHandle);
            this.inputSuppressionTimeoutHandle = null;
        }
        console.log(`🛡️ [Gemini${this.callTag ? ' ' + this.callTag : ''}] Input suppression shield zrušen — první audio od Evy dorazilo`);
    }

    async createSession(
        _leadData: { companyName: string; contactPerson: string; phone: string },
        agentUserId?: string
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const url = `${GEMINI_WS_URL}?key=${this.apiKey}`;
            const prompt = this.getPromptForAgent(agentUserId);

            console.log(`🤖 [Gemini] Creating session (agent: ${agentUserId || 'default'})`);

            this.ws = new WebSocket(url);

            // ── Setup timeout — pokud do SETUP_TIMEOUT_MS nepřijde ani
            // setupComplete ani chyba, session se považuje za nezdařenou.
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

                // Session setup – Gemini Live API formát.
                //
                // ⚠️ input_audio_config ZDE NEPATŘÍ — Gemini API tohle
                // pole v `setup` odmítá. Formát vstupního audia se určuje
                // přes mime_type v realtime_input.audio (viz sendAudio()).
                const setupMessage = {
                    setup: {
                        model: `models/${GEMINI_MODEL}`,
                        generation_config: {
                            response_modalities: ['AUDIO'],
                            speech_config: {
                                voice_config: {
                                    prebuilt_voice_config: {
                                        // ⚠️ ZMĚNA (17.8.2026): Zephyr ("Bright" — jasný,
                                        // energický) → Achernar ("Soft" — měkčí, méně
                                        // naléhavý tón). Obě ženské hlasy.
                                        voice_name: 'Achernar',
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
                                // ⚠️ ZMĚNA (17.8.2026): 300 → 700ms. Filtruje krátké
                                // šumy/artefakty na telefonní lince, které by jinak
                                // spouštěly falešnou "start of speech" detekci.
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

                    // Session ready
                    if (msg.setupComplete) {
                        console.log('✅ [Gemini] Session ready');
                        console.log(`⏱️ [TIMING] ${Date.now()} | setupComplete received`);
                        if (this.setupTimeoutHandle) {
                            clearTimeout(this.setupTimeoutHandle);
                            this.setupTimeoutHandle = null;
                        }
                        this.isReady = true;
                        this.flushAudioQueue();

                        // ── KICK-START — explicitní textový user turn po
                        // setupu, Eva zahájí FÁZI 1 bez čekání na první
                        // VAD-detekovaný turn.
                        this.kickstartTimeoutHandle = setTimeout(() => {
                            this.kickstartTimeoutHandle = null;
                            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                                console.log('⏭️ [Gemini] Kick-start skipped — WS už není otevřený');
                                return;
                            }
                            this.ws.send(JSON.stringify({
                                clientContent: {
                                    turns: [{
                                        role: 'user',
                                        parts: [{ text: '(Zákazník právě zvedl telefon. Zahaj hovor podle FÁZE 1.)' }],
                                    }],
                                    turnComplete: true,
                                },
                            }));
                            console.log(`⏱️ [TIMING] ${Date.now()} | kick-start clientContent sent (po ${KICKSTART_DELAY_MS}ms prodlevě)`);

                            // ⚠️ NOVÉ (17.8.2026) — okamžitě po odeslání
                            // kick-startu zapni input suppression shield.
                            // Chrání přesně tu zranitelnou mezeru mezi
                            // "Eva začíná generovat pozdrav" a "Eva reálně
                            // vydává první audio", kde by zákazníkovo
                            // "Haló?" jinak spustilo falešné přerušení a
                            // restart pozdravu.
                            this.startInputSuppression();
                        }, KICKSTART_DELAY_MS);

                        this.onReady?.();
                        resolve();
                        return;
                    }

                    // ── Chybová odpověď od Gemini
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

                    // ── Tool/function call — top-level zpráva msg.toolCall
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

                                // Gemini protokol vyžaduje potvrzení tool callu
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

                    // Audio output
                    if (msg.serverContent?.modelTurn?.parts) {
                        for (const part of msg.serverContent.modelTurn.parts) {
                            if (part.inlineData?.mimeType?.includes('audio') && part.inlineData.data) {
                                // ⚠️ NOVÉ (17.8.2026) — první audio chunk od Evy
                                // ruší input suppression shield (viz výše).
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
                            // Neškodná záloha — starší formát function callu
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

                    // User transcript (input audio transcription)
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

    /**
     * "POSMRTNÉ VYHODNOCENÍ" — volá geminiCallHandler, když zákazník
     * zavěsil a hovor nemá outcome. Pošle modelu textový turn s
     * informací o zavěšení; model podle sekce "# ZÁKAZNÍK ZAVĚSIL" v
     * promptu okamžitě zavolá end_call_with_outcome podle dosavadního
     * průběhu.
     *
     * @returns true pokud se žádost odeslala (WS otevřený), jinak false —
     *          handler pak nečeká a uklidí hovor rovnou.
     */
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

    /**
     * Přijme µ-law buffer z Twilia, převede na PCM16 16kHz a pošle Gemini
     */
    sendAudio(mulawBuffer: Buffer): void {
        // ⚠️ NOVÉ (17.8.2026) — input suppression shield: dokud Eva
        // nezačala reálně mluvit po kick-startu, příchozí audio od
        // zákazníka se ZAHAZUJE (ne queue, ne posílá) — viz hlavička
        // souboru pro vysvětlení proč. Kontrola musí být úplně první,
        // před isReady/audioQueue logikou níže.
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

        // Konverze: µ-law 8kHz → PCM16 16kHz
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