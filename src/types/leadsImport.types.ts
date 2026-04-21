export interface ExcelLeadRow {
    name: string;
    email: string;
    phone: string;
    ico: string;
    legalForm: string;
    contactPerson: string;
    assignedTo: string;
}

export interface ValidatedLead {
    companyName: string;
    email: string;
    phone: string;
    ico: string;
    legalForm: string;
    contactPerson: string;
    assignedTo: string;
    createdBy: string;
}

export interface ImportSummary {
    totalRows: number;
    inserted: number;
    duplicates: number;
    errors: number;
}

export interface DuplicateRecord {
    row: number;
    ico: string;
    company: string;
}

export interface ErrorRecord {
    row: number;
    error: string;
    data?: Partial<ExcelLeadRow>;
}

export interface MissingAssignmentRow {
    row: number;
    company: string;
}

export interface LeadsImportSuccessResponse {
    success: true;
    summary: ImportSummary;
    duplicates: DuplicateRecord[];
    errors: ErrorRecord[];
}

export interface LeadsImportFailedResponse {
    success: false;
    error: 'MISSING_ASSIGNMENT' | 'VALIDATION_ERROR' | 'PROCESSING_ERROR';
    message: string;
    details?: {
        rowsWithoutAssignment?: MissingAssignmentRow[];
        errors?: ErrorRecord[];
    };
}

export type LeadsImportResponse = LeadsImportSuccessResponse | LeadsImportFailedResponse;

export interface ChunkResult {
    inserted: number;
    duplicateIcos: string[];
}

export interface ValidationResult {
    valid: boolean;
    validLeads: ValidatedLead[];
    errors: ErrorRecord[];
    duplicates: DuplicateRecord[];
    missingAssignments: MissingAssignmentRow[];
}

export interface ParseResult {
    rows: ExcelLeadRow[];
    totalRows: number;
}