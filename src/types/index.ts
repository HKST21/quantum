export type UserRole = 'ADMIN' | 'SALES';

export type LeadStatus =
    | 'NOVY'
    | 'CHCE_NABIDKU'
    | 'POSLAL_FAKTURU'
    | 'NABIDKA_PREDLOZENA'
    | 'CHCE_PODEPSAT_SMLOUVU'
    | 'UZAVRENO'
    | 'NEDOSTUPNY'
    | 'NEZVEDL_TELEFON'
    | 'ODKLADA'
    | 'ODMITNUTO'
    | 'NEKONTAKTOVAT'
    | 'CHCE_KONTAKT_AI';

export type AuditAction =
    | 'LOGIN_SUCCESS'
    | 'LOGIN_FAILED'
    | 'LOGOUT'
    | 'ACCOUNT_LOCKED'
    | 'USER_CREATED'
    | 'USER_DELETED'
    | 'USER_ACTIVATED'
    | 'USER_DEACTIVATED'
    | 'LEAD_CREATED'
    | 'LEAD_UPDATED'
    | 'LEAD_DELETED'
    | 'LEAD_ASSIGNED'
    | 'DATA_IMPORTED'
    | 'DATA_EXPORTED';

export type ProviderType = 'T-Mobile' | 'O2' | 'Předplacenka' | 'Jiný';

export interface User {
    id: string;
    email: string;
    passwordHash: string;
    fullName: string;
    role: UserRole;
    totpSecret: string | null;
    isActive: boolean;
    failedLoginAttempts: number;
    lockedUntil: Date | null;
    lastLogin: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface Lead {
    id: string;
    companyName: string;
    legalForm: string | null;
    ico: string | null;
    contactPerson: string;
    phone: string;
    email: string;
    status: LeadStatus;
    assignedTo: string | null;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
    invoicePromised: boolean;
}

export interface LeadComment {
    id: string;
    leadId: string;
    userId: string;
    oldStatus: LeadStatus | null;
    newStatus: LeadStatus;
    comment: string;
    createdAt: Date;
}

export interface PhoneScreening {
    id: string;
    leadId: string;
    currentProviderType: ProviderType | null;
    currentProviderOther: string | null;
    monthlyTotal: number | null;
    monthlyTotalUnknown: boolean;
    phoneCount: number | null;
    phoneCountUnknown: boolean;
    phoneUnlimited: boolean | null;
    phoneUnlimitedUnknown: boolean;
    hasFixedInternet: boolean | null;
    fixedInternetCount: number | null;
    fixedInternetCountUnknown: boolean;
    hasMobileInternet: boolean | null;
    mobileInternetCount: number | null;
    mobileInternetCountUnknown: boolean;
    hasTv: boolean | null;
    tvCount: number | null;
    tvCountUnknown: boolean;
    notes: string | null;
    screenedAt: string;
    screenedBy: string;
    createdAt: string;
    updatedAt: string;
}

export interface PhoneScreeningRequest {
    currentProviderType?: ProviderType | null;
    currentProviderOther?: string | null;
    monthlyTotal?: number | null;
    monthlyTotalUnknown?: boolean;
    phoneCount?: number | null;
    phoneCountUnknown?: boolean;
    phoneUnlimited?: boolean | null;
    phoneUnlimitedUnknown?: boolean;
    hasFixedInternet?: boolean | null;
    fixedInternetCount?: number | null;
    fixedInternetCountUnknown?: boolean;
    hasMobileInternet?: boolean | null;
    mobileInternetCount?: number | null;
    mobileInternetCountUnknown?: boolean;
    hasTv?: boolean | null;
    tvCount?: number | null;
    tvCountUnknown?: boolean;
    notes?: string | null;
}

export interface InvoiceTariff {
    id: string;
    invoiceDataId: string;
    tariffName: string;
    unitPrice: number;
    quantity: number;
    totalPrice: number;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface InvoiceData {
    id: string;
    leadId: string;
    currentProviderType: ProviderType | null;
    currentProviderOther: string | null;
    deviceInstallmentsNote: string | null;
    contractEndDate: string | null;
    tariffs: InvoiceTariff[];
    totalMonthly: number;
    notes: string | null;
    analyzedAt: string;
    analyzedBy: string;
    createdAt: string;
    updatedAt: string;
}

export interface InvoiceTariffRequest {
    tariffName: string;
    unitPrice: number;
    quantity: number;
    totalPrice: number;
    notes?: string | null;
}

export interface InvoiceDataRequest {
    currentProviderType?: ProviderType | null;
    currentProviderOther?: string | null;
    deviceInstallmentsNote?: string | null;
    contractEndDate?: string | null;
    tariffs: InvoiceTariffRequest[];
    notes?: string | null;
}

export interface LoginRequest {
    email: string;
    password: string;
}

export interface VerifyTwoFactorRequest {
    email: string;
    token: string;
}

export interface CreateUserRequest {
    email: string;
    password: string;
    fullName: string;
    role: UserRole;
}

export interface UserResponse {
    id: string;
    email: string;
    fullName: string;
    role: UserRole;
    isActive: boolean;
    lastLogin: Date | null;
    createdAt: Date;
}

export interface CreateLeadRequest {
    companyName: string;
    legalForm?: string;
    ico?: string;
    contactPerson: string;
    phone: string;
    email: string;
    status?: LeadStatus;
    assignedTo?: string;
}

export interface UpdateLeadRequest {
    companyName?: string;
    legalForm?: string;
    ico?: string;
    contactPerson?: string;
    phone?: string;
    email?: string;
}

export interface ChangeLeadStatusRequest {
    status: LeadStatus;
    comment: string;
    phoneScreening?: PhoneScreeningRequest;
    invoicePromised?: boolean;
}

export interface AssignLeadRequest {
    assignedTo: string;
}

export interface LeadResponse {
    id: string;
    companyName: string;
    legalForm: string | null;
    ico: string | null;
    contactPerson: string;
    phone: string;
    email: string;
    status: LeadStatus;
    assignedTo: { id: string; fullName: string } | null;
    createdBy: { id: string; fullName: string };
    createdAt: Date;
    updatedAt: Date;
    invoicePromised: boolean;
}

export interface LeadDetailResponse extends LeadResponse {
    comments: Array<{
        id: string;
        userId: string;
        userFullName: string;
        oldStatus: LeadStatus | null;
        newStatus: LeadStatus;
        comment: string;
        createdAt: Date;
    }>;
    phoneScreening: PhoneScreening | null;
    invoiceData: InvoiceData | null;
}

export interface LeadListQuery {
    status?: LeadStatus;
    assignedTo?: string;
    search?: string;
    page?: number;
    limit?: number;
}

export interface PaginatedResponse<T> {
    data: T[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
}

export interface AuditLog {
    id: string;
    userId: string | null;
    action: AuditAction;
    targetId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    details: Record<string, any> | null;
    createdAt: Date;
}

declare module 'express-session' {
    interface SessionData {
        userId?: string;
        email?: string;
        role?: UserRole;
        twoFactorVerified?: boolean;
    }
}

declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string;
                email: string;
                fullName: string;
                role: UserRole;
            };
        }
    }
}