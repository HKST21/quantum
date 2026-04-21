import pool from '../db/pool';
import {
    ExcelLeadRow, ValidatedLead, ParseResult, ValidationResult,
    ChunkResult, DuplicateRecord, ErrorRecord, MissingAssignmentRow,
} from '../types/leadsImport.types';

const XLSX = require('xlsx');
const CHUNK_SIZE = 1000;
const MAX_LEADS = 30000;

export const parseExcelFile = (buffer: Buffer): ParseResult => {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('Excel soubor neobsahuje žádný list');

    const worksheet = workbook.Sheets[sheetName];
    const rawData = XLSX.utils.sheet_to_json(worksheet, {
        header: 1, defval: '', blankrows: false,
    }) as any[][];

    if (rawData.length < 2) throw new Error('Excel soubor je prázdný nebo obsahuje pouze header');
    if (rawData.length - 1 > MAX_LEADS) throw new Error(`Překročen maximální limit ${MAX_LEADS} leadů`);

    const rows: ExcelLeadRow[] = rawData.slice(1).map((row) => ({
        name: String(row[0] || '').trim(),
        email: String(row[1] || '').trim(),
        phone: String(row[2] || '').trim(),
        ico: String(row[3] || '').trim().replace(/\s+/g, ''),
        legalForm: String(row[4] || '').trim(),
        contactPerson: String(row[5] || '').trim(),
        assignedTo: String(row[6] || '').trim(),
    }));

    return { rows, totalRows: rows.length };
};

export const validateLeads = async (
    rows: ExcelLeadRow[],
    globalAssignedTo: string | null,
    createdBy: string
): Promise<ValidationResult> => {
    const validLeads: ValidatedLead[] = [];
    const errors: ErrorRecord[] = [];
    const missingAssignments: MissingAssignmentRow[] = [];
    const duplicates: DuplicateRecord[] = [];
    const seenIcos = new Set<string>();

    const existingIcos = await getExistingIcos();

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNumber = i + 2;

        if (!row.name) { errors.push({ row: rowNumber, error: 'Chybí povinné pole: name', data: row }); continue; }
        if (!row.phone) { errors.push({ row: rowNumber, error: 'Chybí povinné pole: phone', data: row }); continue; }
        if (!row.ico) { errors.push({ row: rowNumber, error: 'Chybí povinné pole: ico', data: row }); continue; }

        if (existingIcos.has(row.ico)) { duplicates.push({ row: rowNumber, ico: row.ico, company: row.name }); continue; }
        if (seenIcos.has(row.ico)) { duplicates.push({ row: rowNumber, ico: row.ico, company: row.name }); continue; }

        let assignedTo: string;
        if (globalAssignedTo) {
            assignedTo = globalAssignedTo;
        } else if (row.assignedTo) {
            assignedTo = row.assignedTo;
        } else {
            missingAssignments.push({ row: rowNumber, company: row.name });
            continue;
        }

        if (!isValidUUID(assignedTo)) {
            errors.push({ row: rowNumber, error: `Neplatný UUID pro assigned_to: ${assignedTo}`, data: row });
            continue;
        }

        seenIcos.add(row.ico);
        validLeads.push({
            companyName: row.name, email: row.email, phone: row.phone,
            ico: row.ico, legalForm: row.legalForm, contactPerson: row.contactPerson,
            assignedTo, createdBy,
        });
    }

    return { valid: missingAssignments.length === 0, validLeads, errors, duplicates, missingAssignments };
};

export const bulkInsertLeads = async (leads: ValidatedLead[]): Promise<{ inserted: number; failedIcos: string[] }> => {
    let totalInserted = 0;
    const failedIcos: string[] = [];

    for (let i = 0; i < leads.length; i += CHUNK_SIZE) {
        const chunk = leads.slice(i, i + CHUNK_SIZE);
        const result = await insertChunk(chunk);
        totalInserted += result.inserted;
        failedIcos.push(...result.duplicateIcos);
    }

    return { inserted: totalInserted, failedIcos };
};

const insertChunk = async (leads: ValidatedLead[]): Promise<ChunkResult> => {
    if (leads.length === 0) return { inserted: 0, duplicateIcos: [] };

    const companyNames: string[] = [];
    const legalForms: string[] = [];
    const icos: string[] = [];
    const contactPersons: string[] = [];
    const phones: string[] = [];
    const emails: string[] = [];
    const assignedTos: string[] = [];
    const createdBys: string[] = [];

    for (const lead of leads) {
        companyNames.push(lead.companyName);
        legalForms.push(lead.legalForm);
        icos.push(lead.ico);
        contactPersons.push(lead.contactPerson);
        phones.push(lead.phone);
        emails.push(lead.email);
        assignedTos.push(lead.assignedTo);
        createdBys.push(lead.createdBy);
    }

    const query = `
        WITH input_data AS (
            SELECT
                unnest($1::varchar[]) as company_name,
                unnest($2::varchar[]) as legal_form,
                unnest($3::varchar[]) as ico,
                unnest($4::varchar[]) as contact_person,
                unnest($5::varchar[]) as phone,
                unnest($6::varchar[]) as email,
                unnest($7::uuid[]) as assigned_to,
                unnest($8::uuid[]) as created_by
        ),
        filtered_data AS (
            SELECT id.*
            FROM input_data id
            LEFT JOIN leads l ON l.ico = id.ico
            WHERE l.ico IS NULL
        )
        INSERT INTO leads (
            company_name, legal_form, ico, contact_person, phone, email,
            status, invoice_promised, assigned_to, created_by, created_at, updated_at
        )
        SELECT
            company_name, legal_form, ico, contact_person, phone, email,
            'NOVY'::lead_status, false, assigned_to, created_by, NOW(), NOW()
        FROM filtered_data
        RETURNING ico
    `;

    const result = await pool.query(query, [
        companyNames, legalForms, icos, contactPersons,
        phones, emails, assignedTos, createdBys,
    ]);

    const insertedIcos = new Set(result.rows.map((r: any) => r.ico));
    const duplicateIcos = icos.filter(ico => !insertedIcos.has(ico));

    return { inserted: result.rows.length, duplicateIcos };
};

const getExistingIcos = async (): Promise<Set<string>> => {
    const result = await pool.query(`SELECT ico FROM leads WHERE ico IS NOT NULL AND ico != ''`);
    return new Set(result.rows.map((r: any) => r.ico));
};

const isValidUUID = (str: string): boolean => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
};

export const validateUserExists = async (userId: string): Promise<boolean> => {
    const result = await pool.query('SELECT id FROM users WHERE id = $1 AND is_active = true', [userId]);
    return result.rows.length > 0;
};