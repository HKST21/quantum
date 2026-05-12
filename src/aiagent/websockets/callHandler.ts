import WebSocket from 'ws';
import { OpenAIService } from '../services/openAIService';

interface ActiveCall {
    twilioWs: WebSocket;
    openaiWs: WebSocket | null;
    openaiService: OpenAIService;  // každý hovor má vlastní instanci
    streamSid: string | null;
    callSid: string;
    leadId: string;
    agentUserId: string;
    transcript: string[];
    outcome: any | null;
    monitoringActive: boolean;
    gracefulTimeout?: NodeJS.Timeout;
    fallbackTimeout?: NodeJS.Timeout;
    forceEndTimeout?: NodeJS.Timeout;
}

export class CallHandler {
    private activeCalls: Map<string, ActiveCall> = new Map();
    private agentMap: Map<string, string> = new Map(); // callSid → agentUserId

    setAgentForCall(callSid: string, agentUserId: string): void {
        this.agentMap.set(callSid, agentUserId);
        console.log(`🤖 Agent set for call ${callSid}: ${agentUserId}`);
    }

    async handleConnection(
        twilioWs: WebSocket,
        callSid: string,
        leadId: string,
        leadData: { companyName: string; contactPerson: string; phone: string },
        streamSid: string | null
    ): Promise<void> {
        console.log('📞 New call WebSocket connection:', { callSid, leadId, streamSid });

        const agentUserId = this.agentMap.get(callSid) || process.env.AI_AGENT_USER_ID || '53c65ca7-68bc-4948-83e5-35a64c17f0fb';
        this.agentMap.delete(callSid);

        console.log(`🤖 Using agent: ${agentUserId} for call: ${callSid}`);

        try {
            // KLÍČOVÁ ZMĚNA: nová instance OpenAI pro každý hovor
            const localOpenAIService = new OpenAIService();
            await localOpenAIService.createSession(leadData, agentUserId);
            const openaiWs = localOpenAIService.getWebSocket();

            if (!openaiWs) throw new Error('Failed to create OpenAI session');

            this.activeCalls.set(callSid, {
                twilioWs,
                openaiWs,
                openaiService: localOpenAIService,
                streamSid,
                callSid,
                leadId,
                agentUserId,
                transcript: [],
                outcome: null,
                monitoringActive: false,
            });

            console.log('✅ StreamSid initialized:', streamSid);

            const forceEndTimeout = setTimeout(() => {
                console.warn('⬰ MAX CALL DURATION (120s) - Force ending');
                this.cleanupCall(callSid);
            }, 120000);

            const call = this.activeCalls.get(callSid);
            if (call) call.forceEndTimeout = forceEndTimeout;

            this.setupTwilioHandlers(callSid);
            this.setupOpenAIHandlers(callSid);

            console.log('✅ Call handler initialized for:', callSid);
            console.log('🛡️ Safety: Force end after 120 seconds');
        } catch (error) {
            console.error('❌ Failed to initialize call handler:', error);
            twilioWs.close();
        }
    }

    private setupTwilioHandlers(callSid: string): void {
        const call = this.activeCalls.get(callSid);
        if (!call) return;

        call.twilioWs.on('message', (message: string) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'start':
                        console.log('📞 Twilio stream started:', data.start.streamSid);
                        const updatedCall = this.activeCalls.get(callSid);
                        if (updatedCall) {
                            updatedCall.streamSid = data.start.streamSid;
                            this.activeCalls.set(callSid, updatedCall);
                            console.log('✅ StreamSid saved:', updatedCall.streamSid);
                        }
                        break;

                    case 'media':
                        if (data.media?.payload) {
                            const currentCall = this.activeCalls.get(callSid);
                            if (currentCall) {
                                currentCall.openaiService.sendAudio(data.media.payload);
                            }
                        }
                        break;

                    case 'stop':
                        console.log('📞 Twilio stream stopped');
                        this.cleanupCall(callSid);
                        break;
                }
            } catch (error) {
                console.error('❌ Error processing Twilio message:', error);
            }
        });

        call.twilioWs.on('close', () => {
            console.log('🔌 Twilio WebSocket closed:', callSid);
            this.cleanupCall(callSid);
        });

        call.twilioWs.on('error', (error) => {
            console.error('❌ Twilio WS error:', error);
            this.cleanupCall(callSid);
        });
    }

    private setupOpenAIHandlers(callSid: string): void {
        const call = this.activeCalls.get(callSid);
        if (!call || !call.openaiWs) return;

        call.openaiWs.on('message', (message: Buffer) => {
            try {
                const data = JSON.parse(message.toString());

                if (data.type && !data.type.includes('input_audio_buffer')) {
                    console.log('🤖 OpenAI event:', data.type);
                }

                switch (data.type) {
                    case 'response.output_audio.delta':
                        if (data.delta) {
                            const currentCall = this.activeCalls.get(callSid);
                            if (currentCall?.streamSid) {
                                this.sendAudioToTwilio(callSid, data.delta);
                            }
                        }
                        break;

                    case 'response.output_audio.done':
                        console.log('🔊 AI finished speaking');
                        if (call.monitoringActive) {
                            if (call.fallbackTimeout) {
                                clearTimeout(call.fallbackTimeout);
                                call.fallbackTimeout = undefined;
                            }
                            call.gracefulTimeout = setTimeout(() => {
                                console.log('🛑 Ending call gracefully');
                                this.cleanupCall(callSid);
                            }, 3000);
                        }
                        break;

                    case 'response.output_audio_transcript.delta':
                        if (data.delta) {
                            const last = call.transcript[call.transcript.length - 1];
                            if (last?.startsWith('AI: ')) call.transcript[call.transcript.length - 1] += data.delta;
                            else call.transcript.push(`AI: ${data.delta}`);
                        }
                        break;

                    case 'conversation.item.input_audio_transcription.completed':
                        if (data.transcript) {
                            console.log('💤 User said:', data.transcript);
                            call.transcript.push(`User: ${data.transcript}`);
                        }
                        break;

                    case 'input_audio_buffer.speech_started':
                        if (call.monitoringActive && call.gracefulTimeout) {
                            clearTimeout(call.gracefulTimeout);
                            call.gracefulTimeout = undefined;
                        }
                        break;

                    case 'response.function_call_arguments.done':
                        if (data.name === 'end_call_with_outcome' && data.arguments) {
                            const currentCall = this.activeCalls.get(callSid);
                            if (currentCall) {
                                currentCall.outcome = currentCall.openaiService.parseOutcome({
                                    name: data.name,
                                    arguments: data.arguments,
                                });
                                currentCall.monitoringActive = true;
                                console.log('✅ Call outcome determined:', currentCall.outcome.outcome);

                                currentCall.fallbackTimeout = setTimeout(() => {
                                    if (this.activeCalls.has(callSid)) {
                                        console.log('⬰ Fallback timeout - force ending');
                                        this.cleanupCall(callSid);
                                    }
                                }, 10000);
                            }
                        }
                        break;

                    case 'session.updated':
                        console.log('✅ OpenAI session configured');
                        break;

                    case 'response.done':
                        console.log('✅ OpenAI response completed');
                        break;

                    case 'error':
                        console.error('❌ OpenAI error:', data.error);
                        break;
                }
            } catch (error) {
                console.error('❌ Error processing OpenAI message:', error);
            }
        });

        call.openaiWs.on('close', () => console.log('🔌 OpenAI WS closed:', callSid));

        call.openaiWs.on('error', (error) => {
            console.error('❌ OpenAI WS error:', error);
            setTimeout(() => {
                if (this.activeCalls.has(callSid)) this.cleanupCall(callSid);
            }, 3000);
        });
    }

    private sendAudioToTwilio(callSid: string, audioBase64: string): void {
        const call = this.activeCalls.get(callSid);
        if (!call?.streamSid) return;

        try {
            call.twilioWs.send(JSON.stringify({
                event: 'media',
                streamSid: call.streamSid,
                media: { payload: audioBase64 },
            }));
        } catch (error) {
            console.error('❌ Failed to send audio to Twilio:', error);
        }
    }

    getCallData(callSid: string): { transcript: string; outcome: any | null } | null {
        const call = this.activeCalls.get(callSid);
        if (!call) return null;
        return { transcript: call.transcript.join('\n'), outcome: call.outcome };
    }

    private cleanupCall(callSid: string): void {
        const call = this.activeCalls.get(callSid);
        if (!call) return;

        console.log('🧹 Cleaning up call:', callSid);

        if (call.gracefulTimeout) clearTimeout(call.gracefulTimeout);
        if (call.fallbackTimeout) clearTimeout(call.fallbackTimeout);
        if (call.forceEndTimeout) clearTimeout(call.forceEndTimeout);

        call.openaiService.closeSession();

        if (call.twilioWs.readyState === WebSocket.OPEN) call.twilioWs.close();

        this.activeCalls.delete(callSid);
        console.log('✅ Call cleanup complete:', callSid);
    }

    forceCleanup(callSid: string): void {
        this.cleanupCall(callSid);
    }
}

export const callHandler = new CallHandler();