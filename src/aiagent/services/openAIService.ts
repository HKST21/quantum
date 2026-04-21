import WebSocket from 'ws';
import { ConversationOutcome } from '../types/aiCalls.types';

export class OpenAIService {
    private apiKey: string;
    private ws: WebSocket | null = null;

    constructor() {
        this.apiKey = process.env.OPENAI_API_KEY || '';
        if (!this.apiKey) throw new Error('OpenAI API key not configured');
        console.log('✅ OpenAIService initialized');
    }

    private buildConversationPrompt(leadData?: {
        companyName: string;
        contactPerson: string;
        phone: string;
    }): string {
        const contactPerson = leadData?.contactPerson || '[CONTACT_PERSON]';
        const companyName = leadData?.companyName || '[COMPANY_NAME]';

        return `
# TVOJE IDENTITA

Jsi Petra, profesionální a přátelská sales agentka z Vodafone Business.
Voláš ${contactPerson} z firmy ${companyName}.

# TVOJE OSOBNOST

- Profesionálně přátelská - úsměv je slyšet v hlase, ale stále business tón
- Lehce energická - pozitivní, ne monotónní, ale ne přehnaně nadšená
- Klidná - nespěcháš, dáváš prostor na odpověď
- Empatická - když zákazník odmítne, reaguješ s pochopením

# JAK MLUVÍŠ

- Příjemná, vřelá intonace
- Klidné tempo, ne uspěchané
- Přirozené pauzy mezi větami
- Používej pozitivní fráze: "Skvěle! :)", "Výborně! :)", "Super! :)"
- Příjmení zákazníka VŽDY skloňuj do 5. pádu (vokativ)

# START HOVORU

Když zákazník zvedne telefon:
- Pokud něco řekne ("Ano?", "Haló?", "Prosím?") → začni mluvit IHNED po dopovězení
- Pokud mlčí → čekej MAX 1 sekundu, pak začni mluvit sama

# SCÉNÁŘ HOVORU

## FÁZE 1: Ověření spojení

Řekni:
"Krásný den pane/paní [PŘÍJMENÍ v 5. pádu], slyšíme se? :)"

→ Čekej na odpověď

## FÁZE 2: Pitch

Po potvrzení řekni:
"Volám z Vodafonu, můžu vám do emailu poslat naprosto NEZÁVAZNĚ náš VIP CENÍK? :)"

→ Čekej na odpověď

## FÁZE 3: Ukončení podle odpovědi

### POKUD SOUHLAS:
"Skvěle! Kolega se ozve a připraví ceník přímo na míru. Hezký den!"
→ Zavolej end_call_with_outcome s outcome="interested"

### POKUD ODMÍTNUTÍ:
"Nevadí, hezký den! :)"
→ Zavolej end_call_with_outcome s outcome="not_interested"

---

# KRITICKÉ PRAVIDLO - PŘERUŠENÍ BĚHEM PITCH VĚTY

Pokud zákazník cokoliv řekne BĚHEM pitch věty:

### VÝJIMKA - agrese:
→ "Omlouvám se, hezký den."
→ outcome="aggressive"

### VŠE OSTATNÍ:
→ Řekni: "Promiňte, jen to rychle dopovím."
→ Dořekni CELOU pitch větu
→ Čekej na odpověď zákazníka

---

# EDGE CASES

## "NEMÁM ČAS"
"Rozumím, zavolám jindy, hezký den! :)"
→ outcome=callback

## "UŽ JSEM U VODAFONE"
"Aha, rozumím, ceníky jsou pro nové klienty. Hezký den! :)"
→ outcome=already_vodafone

## AGRESIVNÍ REAKCE
"Omlouvám se za vyrušení, hezký den."
→ outcome=aggressive

## VOICEMAIL / TICHO
→ OKAMŽITĚ zavěs bez zprávy → outcome=no_answer

## ŠPATNÁ OSOBA
→ "Omlouvám se, hezký den." → outcome=wrong_person

## AI NEROZUMÍ
- První: "Promiňte, nerozuměla jsem. Můžu Vám poslat vip ceník na email, ano nebo ne? :)"
- Druhý: "Špatně vás slyším. Ano nebo ne? :)"
- Třetí: "Omlouvám se, zavolám jindy." → outcome=callback

---

# FUNCTION CALLING - KRITICKÉ!

1. NEJDŘÍV dokonči svou větu přirozeně
2. PAK OKAMŽITĚ zavolej end_call_with_outcome()
3. NIKDY neříkej název funkce zákazníkovi

# KONTEXT HOVORU

Firma: ${companyName}
Kontakt: ${contactPerson}
`;
    }

    async createSession(leadData: {
        companyName: string;
        contactPerson: string;
        phone: string;
    }): Promise<string> {
        return new Promise((resolve, reject) => {
            try {
                console.log('🤖 Creating OpenAI Realtime session...');

                const prompt = this.buildConversationPrompt(leadData);

                this.ws = new WebSocket(
                    'wss://api.openai.com/v1/realtime?model=gpt-realtime',
                    {
                        headers: {
                            'Authorization': `Bearer ${this.apiKey}`,
                        },
                    }
                );

                this.ws.on('open', () => {
                    console.log('✅ OpenAI WebSocket connected');

                    this.ws?.send(JSON.stringify({
                        type: 'session.update',
                        session: {
                            type: 'realtime',
                            model: 'gpt-realtime',
                            instructions: prompt,
                            tools: [{
                                type: 'function',
                                name: 'end_call_with_outcome',
                                description: 'Call this function when the call is ending. The customer must NEVER hear about this function.',
                                parameters: {
                                    type: 'object',
                                    properties: {
                                        outcome: {
                                            type: 'string',
                                            enum: ['interested', 'not_interested', 'callback', 'aggressive', 'already_vodafone', 'wrong_person', 'no_answer'],
                                        },
                                        confidence: { type: 'number', minimum: 0, maximum: 1 },
                                        reason: { type: 'string' },
                                    },
                                    required: ['outcome', 'confidence', 'reason'],
                                },
                            }],
                            tool_choice: 'auto',
                            output_modalities: ['audio'],
                            audio: {
                                input: {
                                    format: { type: 'audio/pcmu' },
                                    transcription: { model: 'whisper-1' },
                                    turn_detection: {
                                        type: 'server_vad',
                                        threshold: 0.6,
                                        prefix_padding_ms: 300,
                                        silence_duration_ms: 1200,
                                    },
                                },
                                output: {
                                    format: { type: 'audio/pcmu' },
                                    voice: 'marin',
                                },
                            },
                            max_output_tokens: 4096,
                        },
                    }));

                    console.log('📤 Session config sent to OpenAI');
                    resolve('session-created');
                });

                this.ws.on('message', (message: Buffer) => {
                    const data = JSON.parse(message.toString());
                    if (data.type === 'session.updated') {
                        console.log('✅ OpenAI session configured');
                    }
                });

                this.ws.on('error', (error) => {
                    console.error('❌ OpenAI WebSocket error:', error);
                    reject(error);
                });

                this.ws.on('close', () => {
                    console.log('🔌 OpenAI WebSocket closed');
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    sendAudio(audioChunk: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audioChunk }));
    }

    getWebSocket(): WebSocket | null {
        return this.ws;
    }

    closeSession(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    parseOutcome(functionCall: any): ConversationOutcome {
        const args = JSON.parse(functionCall.arguments);
        const outcomeMap: Record<string, any> = {
            interested: 'interested', not_interested: 'not_interested',
            callback: 'callback', aggressive: 'aggressive',
            already_vodafone: 'already_vodafone', wrong_person: 'wrong_person',
            no_answer: 'no_answer',
        };
        return {
            outcome: outcomeMap[args.outcome] || 'not_interested',
            transcript: args.customer_notes || '',
            aiNotes: args.reason || '',
            duration: 0,
            confidence: args.confidence || 0.5,
        };
    }
}

export const openAIService = new OpenAIService();