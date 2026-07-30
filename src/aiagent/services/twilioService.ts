import Twilio from 'twilio';
import { TwilioCallResponse, TwilioCallStatus } from '../types/aiCalls.types';
import { normalizePhoneNumber } from '../utils/phoneUtils';
import { createAlertThrottled } from '../../services/alertsService';

// ============================================================================
// TWILIO SERVICE - QUANTUM CRM
// ============================================================================
//
// Podporované flow:
//
// 1. Standardní PSTN flow:
//    Backend → Twilio API (client.calls.create) → Twilio PSTN → klient
//
// 2. Odorik BYOC flow (mobilní CLIP):
//    Backend → Odorik API (setForward) → Twilio API s SIP URI
//    → Twilio BYOC trunk → Odorik SIP proxy → PSTN → klient
//
// Při chybách vytváří alerty přes alertsService (throttled).
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

    async initiateCall(
        leadPhone: string,
        leadId: string,
        fromNumber?: string
    ): Promise<TwilioCallResponse> {
        try {
            let destinationUri: string;
            if (leadPhone.startsWith('sip:')) {
                destinationUri = leadPhone;
                console.log('🌐 Using SIP URI destination (Odorik flow):', destinationUri);
            } else {
                const { normalized, isValid } = normalizePhoneNumber(leadPhone);
                if (!isValid) throw new Error(`Invalid phone number format: ${leadPhone}`);
                destinationUri = normalized;
            }

            const callerNumber = fromNumber || this.defaultPhoneNumber;

            if (!callerNumber) {
                throw new Error('No caller phone number configured');
            }

            console.log('📞 Initiating Twilio call:', {
                to: destinationUri,
                from: callerNumber,
                leadId,
            });

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

            // Alert pro monitoring - throttled aby nespammoval
            await createAlertThrottled({
                type: 'TWILIO_CALL_FAILED',
                message: `Twilio initiateCall selhalo pro lead ${leadId}: ${error.message}`,
                severity: 'error',
                metadata: { leadId, leadPhone, fromNumber, error: error.message },
            });

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