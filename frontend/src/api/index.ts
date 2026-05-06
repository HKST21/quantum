const API_BASE = '/api';

// ============================================
// HELPER
// ============================================

const fetchJson = async (url: string, options?: RequestInit) => {
    const res = await fetch(`${API_BASE}${url}`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });

    const data = await res.json();

    if (!res.ok) {
        throw new Error(data.error?.message || `HTTP ${res.status}`);
    }

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
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
}

export const getLeads = (params: {
    status?: string;
    assignedTo?: string;
    search?: string;
    page?: number;
    limit?: number;
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

// ============================================
// AI CALLS — BATCH
// ============================================

export interface BatchStatus {
    isRunning: boolean;
    currentCall: { phone: string; companyName: string } | null;
    today: {
        completed: number;
        interested: number;
        noAnswer: number;
        rejected: number;
        callback: number;
        avgDuration: number;
        conversionRate: number;
    };
    queueSize: number;
}

export interface BatchHistoryItem {
    datum: string;
    celkemHovoru: number;
    completed: number;
    interested: number;
    noAnswer: number;
    rejected: number;
    callback: number;
    avgDuration: number;
    conversionRate: number;
}

export interface BatchResultLead {
    telefon: string;
    jmeno: string;
    firma: string;
    poznamka_evy: string;
    nahravka: string;
    delka_sec: number;
    datum_hovoru: string;
}

export interface UnansweredLead {
    id: string;
    phone: string;
    companyName: string;
    status: string;
    totalAttempts: number;
    attemptsWithRecording: number;
}

export interface AvgDuration {
    avgDuration: number;
    overhead: number;
    totalPerCall: number;
    sampleSize: number;
}

export const getBatchStatus = (): Promise<BatchStatus> =>
    fetchJson('/ai-calls/batch-status');

export const getBatchResults = (date: string): Promise<{ date: string; leads: BatchResultLead[]; total: number }> =>
    fetchJson(`/ai-calls/batch-results?date=${date}`);

export const getBatchHistory = (): Promise<{ batches: BatchHistoryItem[] }> =>
    fetchJson('/ai-calls/batch-history');

export const getTwilioNumber = (): Promise<{ phone: string }> =>
    fetchJson('/ai-calls/twilio-number');

export const getUnanswered = (): Promise<{ leads: UnansweredLead[]; total: number }> =>
    fetchJson('/ai-calls/unanswered');

export const retryUnanswered = (): Promise<{ updated: number; message: string }> =>
    fetchJson('/ai-calls/retry-unanswered', { method: 'POST' });

export const getAvgDuration = (): Promise<AvgDuration> =>
    fetchJson('/ai-calls/avg-duration');

export const startAICalling = (maxCalls: number): Promise<any> =>
    fetchJson('/ai-calls/start', {
        method: 'POST',
        body: JSON.stringify({ maxCalls }),
    });

// ============================================
// USERS
// ============================================

export interface User {
    id: string;
    email: string;
    fullName: string;
    role: string;
    isActive: boolean;
}

export const getUsers = (): Promise<{ users: User[] }> =>
    fetchJson('/users');