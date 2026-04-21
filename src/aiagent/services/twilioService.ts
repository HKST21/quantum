import Twilio from 'twilio';
import { TwilioCallResponse, TwilioCallStatus } from '../types/aiCalls.types';
import { normalizePhoneNumber } from '../utils/phoneUtils';

export class TwilioService {
    private client: Twilio.Twilio;
    private backendUrl: string;
    private twilioPhoneNumber: string;

    constructor() {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;

        if (!accountSid || !authToken) {
            throw new Error('Twilio credentials not configured');
        }

        this.client = Twilio(accountSid, authToken);
        this.backendUrl = process.env.BACKEND_URL || 'https://localhost:5000';
        this.twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER || '';

        console.log('✅ TwilioService initialized:', {
            backendUrl: this.backendUrl,
            twilioPhone: this.twilioPhoneNumber,
        });
    }

    async initiateCall(leadPhone: string, leadId: string): Promise<TwilioCallResponse> {
        try {
            const { normalized, isValid } = normalizePhoneNumber(leadPhone);
            if (!isValid) throw new Error(`Invalid phone number format: ${leadPhone}`);

            console.log('📞 Initiating Twilio call:', { to: normalized, from: this.twilioPhoneNumber, leadId });

            const call = await this.client.calls.create({
                to: normalized,
                from: this.twilioPhoneNumber,
                url: `${this.backendUrl}/api/ai-calls/webhook/twiml`,
                statusCallback: `${this.backendUrl}/api/ai-calls/webhook/status-callback`,
                statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
                statusCallbackMethod: 'POST',
                timeout: 50,
                record: true,
                recordingStatusCallback: `${this.backendUrl}/api/ai-calls/webhook/recording-callback`,
                recordingStatusCallbackEvent: ['completed'],
            });

            console.log('✅ Twilio call created:', { callSid: call.sid, status: call.status });

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