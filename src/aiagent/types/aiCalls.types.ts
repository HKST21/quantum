export type AICallStatus =
    | 'pending'
    | 'calling'
    | 'completed'
    | 'failed'
    | 'skipped';

export type AICallOutcome =
    | 'CHCE_NABIDKU'
    | 'CHCE_KONTAKT_AI'
    | 'NEKONTAKTOVAT'
    | 'NEZVEDL_TELEFON'
    | 'POLOZIL_TELEFON'   // NOVÉ — parita s VF-CRM, vyžaduje DB migraci
    | 'ODKLADA';

// NOVÉ — dvě nezávislé osy, defaultně přesně dnešní chování
export type CallEngine = 'openai' | 'gemini';
export type CallProvider = 'twilio' | 'odorik';

export interface ConversationOutcome {
    outcome:
        | 'interested'
        | 'not_interested'
        | 'callback'
        | 'aggressive'
        | 'already_tmobile'
        | 'wrong_person'
        | 'no_answer'
        | 'hung_up';           // NOVÉ — zákazník fyzicky zvedl a zavěsil bez jasného výsledku
    transcript: string;
    aiNotes: string;
    duration: number;
    confidence: number;
}

export interface AICallLog {
    id: string;
    leadId: string;
    callSid: string | null;
    status: AICallStatus;
    outcome: AICallOutcome | null;
    duration: number | null;
    transcript: string | null;
    aiNotes: string | null;
    errorMessage: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    engine?: CallEngine;       // NOVÉ
}

export interface TwilioCallResponse {
    sid: string;
    status: string;
    to: string;
    from: string;
    duration: string | null;
}

export interface TwilioCallStatus {
    callSid: string;
    status: 'queued' | 'ringing' | 'in-progress' | 'completed' | 'busy' | 'no-answer' | 'failed' | 'canceled';
    duration: number | null;
}

export interface StartAICallingRequest {
    leadIds?: string[];
    maxCalls?: number;
    agentUserId?: string;
    workers?: number;
    provider?: CallProvider;   // NOVÉ — default 'twilio'
    engine?: CallEngine;       // NOVÉ — default 'openai'
}

export interface StartAICallingResponse {
    success: boolean;
    message: string;
    queuedLeads: number;
    aiAgentId: string;
}

export interface StopAICallingResponse {
    success: boolean;
    message: string;
    stoppedCalls: number;
}

export interface AICallStatusResponse {
    isRunning: boolean;
    currentCall: {
        leadId: string;
        companyName: string;
        phone: string;
        aiCallStatus: AICallStatus;
        startedAt: Date;
    } | null;
    queueSize: number;
    completedToday: number;
    successfulToday: number;
}

export interface AICallLogsQuery {
    leadId?: string;
    status?: AICallStatus;
    outcome?: AICallOutcome;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
}

export interface AICallLogsResponse {
    logs: AICallLog[];
    total: number;
    page: number;
    limit: number;
}

export interface NormalizedPhoneNumber {
    original: string;
    normalized: string;
    isValid: boolean;
    country: string;
}