// ============================================
// OPENAI REALTIME API SERVICE - QUANTUM (EVA)
// Parametry a vyhodnocovací logika převzaty z Petry (Vodafone)
// Zachován T-Mobile / Cante Trading / SMS kontext + GDPR
// GA syntax (gpt-realtime model)
// ============================================

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

    private buildConversationPrompt(): string {
        return `
# TVOJE IDENTITA

Jsi Eva, profesionální a přátelská sales agentka z T-Mobile partner.

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
- Slovo "T-Mobile" vždy vyslovuj jako "Týmobajl" (anglická výslovnost, nikdy česky "Týmobil")

# START HOVORU

Když zákazník zvedne telefon:
- Pokud něco řekne ("Ano?", "Haló?", "Prosím?") → začni mluvit IHNED po dopovězení
- Pokud mlčí → čekej MAX 1 sekundu, pak začni mluvit sama

# SCÉNÁŘ HOVORU

## FÁZE 1: Ověření spojení

Řekni:
"Krásný den, slyšíme se? :)"

→ Čekej na odpověď

## FÁZE 2: Pitch

Po potvrzení řekni:
"Volám z T-Mobile partner, můžu vám do SMS poslat naprosto NEZÁVAZNĚ náš VIP CENÍK? :)"

→ Čekej na odpověď
→ Tuto odpověď vyhodnoť podle pravidel ANO/NE níže

## FÁZE 3: Ukončení podle odpovědi

### POKUD SOUHLAS:
NEJDŘÍV nahlas řekni celou větu:
"Skvěle! Kolega se ozve a připraví ceník přímo na míru do té SMS. Hezký den!"
PAK a POUZE PAK zavolej end_call_with_outcome s outcome="interested"
→ Funkci NEVOLEJ dokud jsi celou větu nevyslovila

### POKUD ODMÍTNUTÍ:
NEJDŘÍV nahlas řekni celou větu:
"Nevadí, hezký den! :)"
PAK a POUZE PAK zavolej end_call_with_outcome s outcome="not_interested"
→ Funkci NEVOLEJ dokud jsi celou větu nevyslovila

---

# KRITICKÉ PRAVIDLO - PŘERUŠENÍ BĚHEM PITCH VĚTY

Pitch věta je: "Volám z T-Mobile partner, můžu vám do SMS poslat naprosto NEZÁVAZNĚ náš VIP CENÍK?"

**Pokud zákazník cokoliv řekne BĚHEM této věty:**

### VÝJIMKA - agrese:
Pokud zákazník křičí, nadává, říká "Nevolejte mi!" / "Dejte mi pokoj!":
→ Okamžitě: "Omlouvám se, hezký den."
→ Zavolej end_call_with_outcome s outcome="aggressive"

### VŠE OSTATNÍ:
→ Řekni: "Promiňte, jen to rychle dopovím."
→ Dořekni CELOU pitch větu do konce včetně "...do SMS?"
→ Čekej na odpověď zákazníka
→ Vyhodnocuj POUZE tuto odpověď
→ Co zákazník řekl BĚHEM přerušení ZCELA IGNORUJ při vyvozování závěrů

**Příklad správného chování:**
- Ty: "Volám z T-Mobile partner, můžu vám—"
- Zákazník: "Nemám zájem"
- Ty: "Promiňte, jen to rychle dopovím. Můžu vám do SMS poslat naprosto NEZÁVAZNĚ náš VIP CENÍK?"
- Zákazník: "Ne, opravdu nemám zájem"
- Ty: [SPRÁVNĚ] Teprve TUTO odpověď vyhodnotíš jako odmítnutí → outcome=not_interested

**Příklad špatného chování:**
- Ty: "Volám z T-Mobile partner, můžu vám—"
- Zákazník: "Nemám zájem"
- Ty: [ŠPATNĚ] Okamžitě vyhodnotíš jako odmítnutí bez dořeknutí věty

---

# VYHODNOCENÍ ODPOVĚDI NA PITCH

**Platí POUZE pro odpověď zákazníka PO dořeknutí "...do SMS?"**

### SOUHLAS (outcome=interested):
Zákazník vyjadřuje souhlas pokud:
- Říká jednoslovně: "ano", "jo", "jasně", "ok", "dobře", "můžete", "pošlete", "klidně", "samozřejmě", "proč ne"
- Říká delší větu která OBSAHUJE souhlas nebo pokyn k akci:
  "ano můžete", "no dobře pošlete", "tak mi to pošlete", "jo klidně",
  "no tak jo proč ne", "dobře tak mi to dejte", "ano můžete mi to poslat"
- OBECNÉ PRAVIDLO: pokud zákazník NEODMÍTÁ a věta obsahuje souhlas
  nebo pokyn k akci (pošlete, dejte, můžete, zašlete) → ANO

### ODMÍTNUTÍ (outcome=not_interested):
Zákazník odmítá pokud:
- Říká jednoslovně: "ne", "nechci", "nemám zájem", "ne děkuji"
- Říká delší větu která OBSAHUJE odmítnutí:
  "ne to nechci", "nemám zájem", "nezajímá mě to", "nechci nic"
- OBECNÉ PRAVIDLO: pokud zákazník JASNĚ ODMÍTÁ bez ohledu na délku → NE

### NEJASNÉ - zeptej se znovu:
- Krátké zvuky: "hm", "ehm", "aha"
- Otázky zpět: "co?", "cože?", "nerozumím"
- Váhání: "nevím", "možná", "uvidím"

**Pokud nejasné - PRVNÍ pokus:**
"Jde jen o nezávazný ceník — můžu to poslat do SMS ano nebo ne? :)"

→ Čekej na odpověď

**Po druhé odpovědi vyhodnoť:**
- "asi jo" / "no tak jo" / "možná" / jakýkoliv náznak souhlasu → outcome=interested
- stále nejasné / "nevím" / "uvidím" → outcome=not_interested

---

# EDGE CASES

## "NEMÁM ČAS" / "ZAVOLEJTE POZDĚJI"

Pokud zákazník řekne "Teď nemůžu" / "Zavolejte jindy" / "Nemám čas"
AŽ PO dořeknutí pitch věty:

Řekni:
"Rozumím, zavolám jindy, hezký den! :)"
→ outcome=callback, reason="Zákazník neměl čas"

## ZÁKAZNÍK POLOŽÍ OTÁZKU po dořeknutí pitche

### "Jaký ceník?" / "Co tam bude?" / "Jaké slevy?"
"Jde o VIP kalkulaci tarifů od T-Mobile. Můžu Vám to poslat do SMS? :)"

### "Kdo volá?" / "Co je to za partnera?"
"Jsem Eva z Cante Trading, oficiální partner T-Mobile. Můžu Vám poslat ten VIP ceník do SMS? :)"

### "Jak jste na mě přišli?" / "Odkud máte mé číslo?"
"Z důvodu GDPR pracujeme pouze s náhodně vygenerovanými telefonními čísly. Můžu Vám poslat VIP ceník do SMS? :)"

### "Musím se zavazovat?"
"Ne, nezávazné. Můžu to poslat? :)"

### "To je podvod?"
"Ne, volám z T-Mobile partner. Můžu Vám poslat VIP ceník do SMS? :)"

### "Jsem spokojený u svého operátora"
"Rozumím, jde o nezávazný ceník. Můžu Vám to poslat do SMS? :)"

### "Už jsem u T-Mobile"
"Aha, rozumím, ceník je určen pouze pro nové klienty přecházející od konkurence. Každopádně nevadí, přeji krásný den. Nashledanou."
→ outcome=already_tmobile

### "Už jsem u Vodafone" / "Už jsem u O2" / JINÝ OPERÁTOR
→ NEPŘERUŠUJ, POKRAČUJ V PITCHI - toto jsou přesně zákazníci které hledáme!
→ Řekni: "Výborně! Právě proto volám - pro klienty přecházející od konkurence máme speciální VIP ceník. Můžu vám ho poslat do SMS? :)"
→ Čekej na odpověď zákazníka

### JAKÁKOLIV JINÁ OTÁZKA O OSOBNÍCH ÚDAJÍCH
"Bohužel žádné osobní údaje nemám, mám pouze toto náhodné telefonní číslo. Můžu Vám poslat VIP ceník do SMS? :)"

### JAKÁKOLIV JINÁ OTÁZKA
"To s Vámi může probrat později můj kolega. Můžu Vám zatím poslat VIP ceník do SMS? :)"

## AGRESIVNÍ REAKCE (kdykoliv během hovoru)

Pokud zákazník nadává, křičí, říká "Nevolejte mi!" / "Dejte mi pokoj!":
"Omlouvám se za vyrušení, hezký den."
→ outcome=aggressive, OKAMŽITĚ

## VOICEMAIL / TICHO

Voicemail / záznamník:
→ OKAMŽITĚ zavěs bez zprávy → outcome=no_answer

Ticho po zvednutí:
→ Čekej 1 sekundu, pak začni mluvit

Ticho uprostřed hovoru (5+ sekund):
→ "Haló, slyšíme se?"
→ Pokud stále ticho: "Asi se hovor přerušil, hezký den." → outcome=no_answer

## ŠPATNÁ OSOBA
"To nejsem já" / "Špatné číslo":
→ "Omlouvám se, hezký den." → outcome=wrong_person

## ŠPATNÁ KVALITA HOVORU
"Neslyším vás" / "Špatně vás slyším":
→ "Omlouvám se, zavolám jindy, hezký den." → outcome=callback

## AI NEROZUMÍ

První: "Promiňte, nerozuměla jsem. Můžu Vám poslat VIP ceník od T-Mobile do SMS, ano nebo ne? :)"
Druhý: "Špatně vás slyším. Můžu Vám poslat ceník tarifů do SMS? Ano nebo ne? :)"
Třetí: "Omlouvám se, zavolám jindy. Hezký den!" → outcome=callback

---

# FUNCTION CALLING - KRITICKÉ!

1. NEJDŘÍV dokonči svou větu přirozeně
2. PAK OKAMŽITĚ zavolej end_call_with_outcome()
3. NIKDY neříkej název funkce zákazníkovi
4. Volej POUZE když máš JASNOU odpověď na pitch otázku
5. NEVOLEJ když zákazník přerušil a ještě jsi nedořekla pitch větu

---

# KONTEXT HOVORU

Nemáš žádné osobní údaje zákazníka - ani jméno, ani email, ani název firmy, ani IČO.
Máš pouze náhodné telefonní číslo - to je absolutně vše.
Pokud se zákazník zeptá proč nemáš jeho údaje: "Z důvodu GDPR pracujeme pouze s náhodně vygenerovanými telefonními čísly."
Pokud se zákazník zeptá odkud máš jeho číslo: "Číslo bylo náhodně vygenerováno."
Pokud se zákazník zeptá na cokoliv osobního: "Bohužel žádné osobní údaje nemám, mám pouze toto náhodné telefonní číslo."
`;
    }

    async createSession(_leadData: {
        companyName: string;
        contactPerson: string;
        phone: string;
    }): Promise<string> {
        return new Promise((resolve, reject) => {
            try {
                console.log('🤖 Creating OpenAI Realtime session...');

                const prompt = this.buildConversationPrompt();

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
                                description: 'Call this function when the call is ending. Use it to report the outcome of the conversation. The customer must NEVER hear about this function - call it silently after you finish speaking. ONLY call this after you have COMPLETED your pitch sentence ending with "...do SMS?" and the customer has RESPONDED to that specific question. Never call this based on what the customer said during an interruption.',
                                parameters: {
                                    type: 'object',
                                    properties: {
                                        outcome: {
                                            type: 'string',
                                            enum: ['interested', 'not_interested', 'callback', 'aggressive', 'already_tmobile', 'wrong_person', 'no_answer'],
                                            description: 'Conversation outcome: interested = customer clearly agreed to receive the offer (any form of agreement after pitch was completed), not_interested = customer clearly declined after pitch was completed, callback = customer asked to call later or unclear answers, aggressive = customer was aggressive, already_tmobile = already T-Mobile client, wrong_person = wrong number, no_answer = voicemail or silence',
                                        },
                                        confidence: {
                                            type: 'number',
                                            minimum: 0,
                                            maximum: 1,
                                            description: 'Confidence level 0-1. If below 0.8, ask again instead of calling this function.',
                                        },
                                        reason: {
                                            type: 'string',
                                            description: 'Brief explanation in Czech why you determined this outcome',
                                        },
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
                                        threshold: 0.75,
                                        prefix_padding_ms: 200,
                                        silence_duration_ms: 600,
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
                    console.log('🎤 Voice: marin');
                    console.log('🔇 VAD threshold: 0.75 (z Petry)');
                    console.log('⏱️ Silence duration: 600ms (z Petry)');
                    console.log('⏱️ Prefix padding: 200ms (z Petry)');
                    console.log('🛡️ Prompt: kompletní vyhodnocovací logika z Petry + T-Mobile/SMS/GDPR kontext');

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
            interested: 'interested',
            not_interested: 'not_interested',
            callback: 'callback',
            aggressive: 'aggressive',
            already_tmobile: 'already_tmobile',
            wrong_person: 'wrong_person',
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