import Twilio from 'twilio';
import { TwilioCallResponse, TwilioCallStatus } from '../types/aiCalls.types';
import { normalizePhoneNumber } from '../utils/phoneUtils';

// ============================================================================
// TWILIO SERVICE - QUANTUM CRM
// ============================================================================
//
// Standardní flow:
//   Backend → Twilio API (client.calls.create) → PSTN → klient
//
// Odorik BYOC flow (aktivní když from = ODORIK_PHONE_NUMBER):
//   Backend → Twilio API s byoc parametrem → SIP INVITE na sip.odorik.cz
//   → Odorik proxy → PSTN → klient (klient vidí Odorik CLIP)
//
// ============================================================================
// !!! ODORIK SIP JMÉNO TEST !!!
// ============================================================================
// AKTIVNÍ TESTOVACÍ CESTA - odstraň po dokončení testu s Petrem Soukupem.
//
// Dočasně přidán support pro SIP URI destinace (např. sip:hejda_test1@sip.odorik.cz).
// Účel: Otestovat Twilio → Odorik napojení přes SIP jméno místo přímého volání
// na telefonní číslo. Petr Soukup vytvořil SIP jméno "hejda_test1" na Odorik
// straně s přesměrováním na jeho vlastní mobil, aby si mohl osobně ověřit funkci.
//
// Jak funguje: když leadPhone v DB začíná "sip:", přeskočí se normalizace
// telefonního čísla a URI se pošle přímo do Twilio API jako "to" parametr.
// Twilio SIP URI destinace nativně podporuje (viz twilio.com/docs/voice/api/sip-making-calls).
//
// PO ODSTRANĚNÍ TESTU:
//   1. Smaž blok mezi "ODORIK SIP TEST START" a "ODORIK SIP TEST END"
//   2. Vrať do metody initiateCall původní řádky:
//        const { normalized, isValid } = normalizePhoneNumber(leadPhone);
//        if (!isValid) throw new Error(`Invalid phone number format: ${leadPhone}`);
//   3. V callParams změň to: destinationUri zpět na to: normalized
//   4. Smaž test leady s "sip:" phone hodnotou z DB
// ============================================================================

export class TwilioService {
    private client: Twilio.Twilio;
    private backendUrl: string;
    private defaultPhoneNumber: string;

    constructor() {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;

        if (!accountSid || !authToken) {
            throw new Error('Twilio credentials not configured');
        }

        this.client = Twilio(accountSid, authToken);
        this.backendUrl = process.env.BACKEND_URL || 'https://localhost:5000';
        this.defaultPhoneNumber = process.env.TWILIO_PHONE_NUMBER || '';

        console.log('✅ TwilioService initialized:', {
            backendUrl: this.backendUrl,
            defaultPhone: this.defaultPhoneNumber,
        });
    }

    /**
     * Initiate outbound call
     * @param leadPhone - Cílové číslo (E.164 formát) NEBO SIP URI (test režim)
     * @param leadId - UUID leadu v DB
     * @param fromNumber - Volitelné číslo volajícího, jinak fallback na TWILIO_PHONE_NUMBER
     */
    async initiateCall(
        leadPhone: string,
        leadId: string,
        fromNumber?: string
    ): Promise<TwilioCallResponse> {
        try {
            // =====================================================
            // ODORIK SIP TEST START - odstraň po testu
            // =====================================================
            // Podpora SIP URI destinace (test s Petrem přes hejda_test1@sip.odorik.cz).
            // Když leadPhone začíná "sip:", přeskočíme normalizaci a použijeme URI přímo.
            let destinationUri: string;
            if (leadPhone.startsWith('sip:')) {
                destinationUri = leadPhone;
                console.log('🧪 [ODORIK SIP TEST] Using SIP URI directly:', destinationUri);
            } else {
                const { normalized, isValid } = normalizePhoneNumber(leadPhone);
                if (!isValid) throw new Error(`Invalid phone number format: ${leadPhone}`);
                destinationUri = normalized;
            }
            // =====================================================
            // ODORIK SIP TEST END
            // =====================================================

            // Použij předané číslo nebo fallback na ENV
            const callerNumber = fromNumber || this.defaultPhoneNumber;

            if (!callerNumber) {
                throw new Error('No caller phone number configured');
            }

            console.log('📞 Initiating Twilio call:', {
                to: destinationUri,
                from: callerNumber,
                leadId,
            });

            // Base parametry pro Twilio call
            const callParams: any = {
                to: destinationUri,
                from: callerNumber,
                url: `${this.backendUrl}/api/ai-calls/webhook/twiml`,
                statusCallback: `${this.backendUrl}/api/ai-calls/webhook/status-callback`,
                statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
                statusCallbackMethod: 'POST',
                timeout: 50,
                record: true,
                recordingStatusCallback: `${this.backendUrl}/api/ai-calls/webhook/recording-callback`,
                recordingStatusCallbackEvent: ['completed'],
            };

            // Pokud voláme z Odorik čísla, přidej BYOC trunk SID
            const odorikNumber = process.env.ODORIK_PHONE_NUMBER;
            const odorikTrunkSid = process.env.ODORIK_BYOC_TRUNK_SID;
            if (odorikNumber && odorikTrunkSid && callerNumber === odorikNumber) {
                console.log('🌐 Routing přes Odorik BYOC trunk:', odorikTrunkSid);
                callParams.byoc = odorikTrunkSid;
            }

            const call = await this.client.calls.create(callParams);

            console.log('✅ Twilio call created:', {
                callSid: call.sid,
                status: call.status,
                to: call.to,
                from: call.from,
                recording: 'enabled',
            });

            return { sid: call.sid, status: call.status, to: call.to, from: call.from, duration: null };
        } catch (error: any) {
            console.error('❌ Twilio call initiation failed:', error);
            throw new Error(`Twilio call failed: ${error.message}`);
        }
    }

    async getCallStatus(callSid: string): Promise<TwilioCallStatus> {
        try {
            const call = await this.client.calls(callSid).fetch();
            return {
                callSid: call.sid,
                status: call.status as any,
                duration: call.duration ? parseInt(call.duration) : null,
            };
        } catch (error: any) {
            throw new Error(`Failed to get call status: ${error.message}`);
        }
    }

    async hangupCall(callSid: string): Promise<void> {
        try {
            await this.client.calls(callSid).update({ status: 'completed' });
        } catch (error: any) {
            throw new Error(`Failed to hangup call: ${error.message}`);
        }
    }

    generateTwiML(callSid: string): string {
        const wsUrl = `wss://${this.backendUrl.replace('https://', '')}/api/ai-calls/websocket`;
        return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${wsUrl}">
            <Parameter name="callSid" value="${callSid}" />
        </Stream>
    </Connect>
</Response>`;
    }
}

export const twilioService = new TwilioService();