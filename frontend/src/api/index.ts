const API_BASE = '/api';

const fetchJson = async (url: string, options?: RequestInit) => {
    const res = await fetch(`${API_BASE}${url}`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    return data;
};

// ============================================
// LEADS
// ============================================

export interface Lead {
    id: string;
    companyName: string;
    legalForm: string | null;
    ico: string | null;
    contactPerson: string;
    phone: string;
    email: string;
    status: string;
    assignedTo: { id: string; fullName: string } | null;
    createdBy: { id: string; fullName: string };
    createdAt: string;
    updatedAt: string;
    invoicePromised: boolean;
    phoneScreening: any | null;
}

export interface LeadsResponse {
    data: Lead[];
    pagination: { page: number; limit: number; total: number; totalPages: number; };
}

export const getLeads = (params: {
    status?: string; assignedTo?: string; search?: string; page?: number; limit?: number;
}): Promise<LeadsResponse> => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.assignedTo) query.set('assignedTo', params.assignedTo);
    if (params.search) query.set('search', params.search);
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    return fetchJson(`/leads?${query.toString()}`);
};

export const blacklistLead = (id: string) =>
    fetchJson(`/ai-calls/leads/${id}/blacklist`, { method: 'PATCH' });

export const deleteLeads = (agentId: string, count: number) =>
    fetchJson('/ai-calls/delete-leads', {
        method: 'POST',
        body: JSON.stringify({ agentId, count }),
    });

export const reassignLeads = (fromAgentId: string, toAgentId: string, count: number) =>
    fetchJson('/ai-calls/reassign-leads', {
        method: 'POST',
        body: JSON.stringify({ fromAgentId, toAgentId, count }),
    });

// ============================================
// AI CALLS — BATCH
// ============================================

export interface BatchStatus {
    isRunning: boolean;
    currentCall: { phone: string; companyName: string } | null;
    today: {
        completed: number; interested: number; noAnswer: number; hungUp: number;
        rejected: number; callback: number; avgDuration: number; conversionRate: number;
    };
    queueSize: number;
}

export interface BatchHistoryItem {
    datum: string;
    agentId: string;
    agentName: string;
    celkemHovoru: number;
    completed: number;
    interested: number;
    noAnswer: number;
    hungUp: number;
    rejected: number;
    callback: number;
    avgDuration: number;
    conversionRate: number;
}

export interface BatchResultLead {
    telefon: string; jmeno: string; firma: string;
    poznamka_evy: string; nahravka: string; delka_sec: number; datum_hovoru: string;
}

export interface UnansweredLead {
    id: string; phone: string; companyName: string;
    status: string; totalAttempts: number; attemptsWithRecording: number;
}

export interface AvgDuration {
    avgDuration: number; overhead: number; totalPerCall: number; sampleSize: number;
}

export interface Agent {
    id: string; fullName: string; email: string;
}

// ⚠️ NOVÉ (25.9.2026) — jedna FB identita = SIP jméno + VLASTNÍ CLIP.
// Na rozdíl od mobilni/pevna (sdílené phoneNumber pro celou skupinu),
// fb skupina má u KAŽDÉ identity jiné CLIP.
export interface OdorikIdentity {
    sipName: string;
    fromNumber: string;
}

export interface OdorikLineConfig {
    sipNames: string[];
    maxWorkers: number;
    phoneNumber: string | null;
}

// ⚠️ NOVÉ — tvar pro 'fb' skupinu je JINÝ než OdorikLineConfig (pole
// identit místo sipNames+phoneNumber).
export interface OdorikFbLineConfig {
    identities: OdorikIdentity[];
    maxWorkers: number;
}

export interface OdorikConfig {
    lines: {
        mobilni: OdorikLineConfig;
        pevna: OdorikLineConfig;
        fb: OdorikFbLineConfig;
    };
}

// 'asterisk' = vlastní ústředna (Hetzner) + Odorik. Hovory nevolá backend,
// jen zapíše úkol do tabulky batch_jobs (viz aiCalls.controller.ts).
export type CallProvider = 'twilio' | 'odorik' | 'asterisk';
export type CallEngine = 'openai' | 'gemini';
export type OdorikLine = 'mobilni' | 'pevna' | 'fb';

// ⚠️ NOVÉ (25.9.2026) — 'parallel' = dosavadní chování (N workerů
// souběžně). 'rotating' = sekvenční, identita se mění kolo dokola —
// zatím jen pro 'fb' linku (anti-spam).
export type CallMode = 'parallel' | 'rotating';

export const getBatchStatus = (agentUserId?: string): Promise<BatchStatus> => {
    const query = agentUserId ? `?agentUserId=${agentUserId}` : '';
    return fetchJson(`/ai-calls/batch-status${query}`);
};

export const getBatchResults = (date: string, agentUserId?: string): Promise<{ date: string; leads: BatchResultLead[]; total: number }> => {
    const query = agentUserId ? `&agentUserId=${agentUserId}` : '';
    return fetchJson(`/ai-calls/batch-results?date=${date}${query}`);
};

export const getBatchHistory = (): Promise<{ batches: BatchHistoryItem[] }> =>
    fetchJson('/ai-calls/batch-history');

export const getTwilioNumber = (): Promise<{ phone: string }> =>
    fetchJson('/ai-calls/twilio-number');

export const getOdorikConfig = (): Promise<OdorikConfig> =>
    fetchJson('/ai-calls/odorik-config');

export const getUnanswered = (agentUserId?: string): Promise<{ leads: UnansweredLead[]; total: number }> => {
    const query = agentUserId ? `?agentUserId=${agentUserId}` : '';
    return fetchJson(`/ai-calls/unanswered${query}`);
};

export const retryUnanswered = (agentUserId?: string): Promise<{ updated: number; message: string }> =>
    fetchJson('/ai-calls/retry-unanswered', {
        method: 'POST',
        body: JSON.stringify({ agentUserId }),
    });

export const getAvgDuration = (): Promise<AvgDuration> =>
    fetchJson('/ai-calls/avg-duration');

export const startAICalling = (
    maxCalls: number,
    agentUserId: string,
    workers: number = 1,
    provider: CallProvider = 'twilio',
    engine: CallEngine = 'openai',
    odorikLine: OdorikLine = 'mobilni',
    callMode: CallMode = 'parallel'
): Promise<any> =>
    fetchJson('/ai-calls/start', {
        method: 'POST',
        body: JSON.stringify({ maxCalls, agentUserId, workers, provider, engine, odorikLine, callMode }),
    });

// Zastavení dávky přes ústřednu (provider 'asterisk'). Rozběhnutý hovor
// doběhne, další se už nevytočí. Pro Twilio/Odorik dávky nic nedělá.
export const stopAICalling = (agentUserId?: string): Promise<{ success: boolean; message: string; stoppedCalls: number }> =>
    fetchJson('/ai-calls/stop', {
        method: 'POST',
        body: JSON.stringify({ agentUserId }),
    });

// ============================================
// BATCH JOBS — živý přehled dávky na ústředně + podrobný log (jen ADMIN, 3 dny)
// ============================================

export interface BatchJobInfo {
    id: string;
    agentId: string;
    agentName: string;
    status: 'pending' | 'running' | 'completed' | 'stopped' | 'failed';
    queuedLeads: number | null;
    processedLeads: number;
    maxCalls: number;
    stopRequested: boolean;
    errorMessage: string | null;
    createdAt: string;
    startedAt: string | null;
    heartbeatAt: string | null;
    finishedAt: string | null;
    hasLog: boolean;
    logBytes: number;
}

export interface ActiveBatchJobInfo extends BatchJobInfo {
    lastLogAt: string | null;
    lastLogAgeSec: number | null;
    heartbeatAgeSec: number | null;
    tail: string[];
}

export interface BatchJobDaySummary {
    date: string;      // YYYY-MM-DD (Europe/Prague)
    agentId: string;
    logs: number;      // kolik dávek toho dne má uložený log
    jobIds: string[];
}

export const getActiveBatchJob = (): Promise<{ active: ActiveBatchJobInfo | null; recent: BatchJobInfo[] }> =>
    fetchJson('/ai-calls/batch-jobs/active');

export const getBatchJobsForDay = (date: string, agentUserId?: string): Promise<{ date: string; jobs: BatchJobInfo[] }> => {
    const query = agentUserId ? `&agentUserId=${agentUserId}` : '';
    return fetchJson(`/ai-calls/batch-jobs?date=${encodeURIComponent(date.slice(0, 10))}${query}`);
};

export const getBatchJobsSummary = (): Promise<{ days: BatchJobDaySummary[] }> =>
    fetchJson('/ai-calls/batch-jobs/summary');

// Log se stahuje přímým odkazem (<a href download>) — fetchJson umí jen JSON.
export const batchJobLogUrl = (jobId: string): string =>
    `${API_BASE}/ai-calls/batch-jobs/${jobId}/log`;

export const getAgents = (): Promise<{ users: Agent[] }> =>
    fetchJson('/users');

// ============================================
// USERS
// ============================================

export interface User {
    id: string; email: string; fullName: string; role: string; isActive: boolean;
}

export const getUsers = (): Promise<{ users: User[] }> =>
    fetchJson('/users');