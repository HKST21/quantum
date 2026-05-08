import WebSocket from 'ws';
import { ConversationOutcome } from '../types/aiCalls.types';
import { evaV1Prompt } from '../prompts/eva_v1';
import { evaV2Prompt } from '../prompts/eva_v2';
import { evaV3Prompt } from '../prompts/eva_v3';
import { evaV4Prompt } from '../prompts/eva_v4';

// Mapa agentů → prompty
const AGENT_PROMPTS: Record<string, () => string> = {
    '53c65ca7-68bc-4948-83e5-35a64c17f0fb': evaV1Prompt, // Eva V1 — VIP ceník do SMS
    'aeec78ff-a86b-4cab-b33a-adeb7c94f08e': evaV2Prompt, // Eva V2 — 40% úspora
    'e7a469bb-4783-4f96-b961-03dd503e5bfa': evaV3Prompt, // Eva V3 — nepřeplácíte?
    'f4adb349-70c3-4e63-8670-81f6c177f61d': evaV4Prompt, // Eva V4 — nezávazné porovnání
};

export class OpenAIService {
    private apiKey: string;
    private ws: WebSocket | null = null;

    constructor() {
        this.apiKey = process.env.OPENAI_API_KEY || '';
        if (!this.apiKey) throw new Error('OpenAI API key not configured');
        console.log('✅ OpenAIService initialized');
    }

    private getPromptForAgent(agentUserId: string): string {
        const promptFn = AGENT_PROMPTS[agentUserId];
        if (!promptFn) {
            console.warn(`⚠️ No prompt found for agent ${agentUserId}, falling back to V1`);
            return evaV1Prompt();
        }
        return promptFn();
    }

    async createSession(
        _leadData: { companyName: string; contactPerson: string; phone: string },
        agentUserId?: string
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            try {
                const agentId = agentUserId || process.env.AI_AGENT_USER_ID || '53c65ca7-68bc-4948-83e5-35a64c17f0fb';
                const prompt = this.getPromptForAgent(agentId);

                console.log(`🤖 Creating OpenAI session for agent: ${agentId}`);

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
                                description: 'Call this function when the call is ending. Use it to report the outcome of the conversation. The customer must NEVER hear about this function - call it silently after you finish speaking. ONLY call this after you have COMPLETED your pitch sentence and the customer has RESPONDED to that specific question. Never call this based on what the customer said during an interruption.',
                                parameters: {
                                    type: 'object',
                                    properties: {
                                        outcome: {
                                            type: 'string',
                                            enum: ['interested', 'not_interested', 'callback', 'aggressive', 'already_tmobile', 'wrong_person', 'no_answer'],
                                            description: 'Conversation outcome',
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