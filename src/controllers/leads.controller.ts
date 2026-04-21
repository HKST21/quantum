import { Request, Response, NextFunction } from 'express';
import pool, { rowToCamelCase, rowsToCamelCase } from '../db/pool';
import { logAuditAction } from '../middleware/auditLog';
import { BadRequestError, NotFoundError, ForbiddenError } from '../utils/errors';
import {
    Lead, LeadResponse, LeadDetailResponse, CreateLeadRequest, UpdateLeadRequest,
    ChangeLeadStatusRequest, AssignLeadRequest, LeadListQuery, PaginatedResponse,
    PhoneScreening, InvoiceData, InvoiceTariff,
} from '../types';

export const listLeads = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { status, assignedTo, search, page = 1, limit = 500 } = req.query as LeadListQuery;

        let actualLimit: number;
        let actualOffset: number;

        if (req.user!.role === 'SALES' || req.user!.role === 'ADMIN') {
            actualLimit = 10000;
            actualOffset = 0;
        } else {
            actualLimit = Number(limit);
            actualOffset = (Number(page) - 1) * Number(limit);
        }

        const conditions: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        if (req.user!.role === 'SALES') {
            conditions.push(`l.assigned_to = $${paramIndex}`);
            params.push(req.user!.id);
            paramIndex++;
        }

        if (req.user!.role === 'ADMIN' && assignedTo) {
            conditions.push(`l.assigned_to = $${paramIndex}`);
            params.push(assignedTo);
            paramIndex++;
        }

        if (status) {
            conditions.push(`l.status = $${paramIndex}`);
            params.push(status);
            paramIndex++;
        }

        if (search) {
            conditions.push(`(
                l.company_name ILIKE $${paramIndex} OR
                l.contact_person ILIKE $${paramIndex} OR
                l.email ILIKE $${paramIndex} OR
                l.phone ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countResult = await pool.query(
            `SELECT COUNT(*) as total FROM leads l ${whereClause}`, params
        );
        const total = parseInt(countResult.rows[0].total);

        params.push(actualLimit, actualOffset);
        const result = await pool.query(
            `SELECT
                l.id, l.company_name, l.legal_form, l.ico, l.contact_person,
                l.phone, l.email, l.status, l.created_at, l.updated_at,
                l.invoice_promised,
                json_build_object('id', u_assigned.id, 'fullName', u_assigned.full_name) as assigned_to,
                json_build_object('id', u_created.id, 'fullName', u_created.full_name) as created_by,
                (SELECT row_to_json(ps)
                 FROM (
                     SELECT id, lead_id, current_provider_type, current_provider_other,
                            monthly_total, monthly_total_unknown,
                            phone_count, phone_count_unknown, phone_unlimited, phone_unlimited_unknown,
                            has_fixed_internet, fixed_internet_count, fixed_internet_count_unknown,
                            has_mobile_internet, mobile_internet_count, mobile_internet_count_unknown,
                            has_tv, tv_count, tv_count_unknown,
                            notes, screened_at, screened_by, created_at, updated_at
                     FROM phone_screening WHERE lead_id = l.id
                 ) ps) as phone_screening
             FROM leads l
             LEFT JOIN users u_assigned ON l.assigned_to = u_assigned.id
             INNER JOIN users u_created ON l.created_by = u_created.id
             ${whereClause}
             ORDER BY l.created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            params
        );

        const leads = result.rows.map((row) => ({
            id: row.id,
            companyName: row.company_name,
            legalForm: row.legal_form,
            ico: row.ico,
            contactPerson: row.contact_person,
            phone: row.phone,
            email: row.email,
            status: row.status,
            invoicePromised: row.invoice_promised,
            assignedTo: row.assigned_to.id ? row.assigned_to : null,
            createdBy: row.created_by,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            phoneScreening: row.phone_screening ? {
                id: row.phone_screening.id,
                leadId: row.phone_screening.lead_id,
                currentProviderType: row.phone_screening.current_provider_type,
                currentProviderOther: row.phone_screening.current_provider_other,
                monthlyTotal: row.phone_screening.monthly_total ? parseFloat(row.phone_screening.monthly_total) : null,
                monthlyTotalUnknown: row.phone_screening.monthly_total_unknown,
                phoneCount: row.phone_screening.phone_count,
                phoneCountUnknown: row.phone_screening.phone_count_unknown,
                phoneUnlimited: row.phone_screening.phone_unlimited,
                phoneUnlimitedUnknown: row.phone_screening.phone_unlimited_unknown,
                hasFixedInternet: row.phone_screening.has_fixed_internet,
                fixedInternetCount: row.phone_screening.fixed_internet_count,
                fixedInternetCountUnknown: row.phone_screening.fixed_internet_count_unknown,
                hasMobileInternet: row.phone_screening.has_mobile_internet,
                mobileInternetCount: row.phone_screening.mobile_internet_count,
                mobileInternetCountUnknown: row.phone_screening.mobile_internet_count_unknown,
                hasTv: row.phone_screening.has_tv,
                tvCount: row.phone_screening.tv_count,
                tvCountUnknown: row.phone_screening.tv_count_unknown,
                notes: row.phone_screening.notes,
                screenedAt: row.phone_screening.screened_at,
                screenedBy: row.phone_screening.screened_by,
                createdAt: row.phone_screening.created_at,
                updatedAt: row.phone_screening.updated_at,
            } : null,
        })) as LeadResponse[];

        const response: PaginatedResponse<LeadResponse> = {
            data: leads,
            pagination: {
                page: Number(page),
                limit: actualLimit,
                total,
                totalPages: Math.ceil(total / actualLimit),
            },
        };

        res.status(200).json(response);
    } catch (error) {
        next(error);
    }
};

export const getLeadDetail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;

        const leadResult = await pool.query(
            `SELECT
                l.id, l.company_name, l.legal_form, l.ico, l.contact_person,
                l.phone, l.email, l.status, l.created_at, l.updated_at, l.invoice_promised,
                json_build_object('id', u_assigned.id, 'fullName', u_assigned.full_name) as assigned_to,
                json_build_object('id', u_created.id, 'fullName', u_created.full_name) as created_by
             FROM leads l
             LEFT JOIN users u_assigned ON l.assigned_to = u_assigned.id
             INNER JOIN users u_created ON l.created_by = u_created.id
             WHERE l.id = $1`,
            [id]
        );

        if (leadResult.rows.length === 0) throw new NotFoundError('Lead not found');

        const leadRow = leadResult.rows[0];

        if (req.user!.role === 'SALES' && leadRow.assigned_to?.id !== req.user!.id) {
            throw new ForbiddenError('You can only access your own leads');
        }

        const commentsResult = await pool.query(
            `SELECT lc.id, lc.user_id, lc.old_status, lc.new_status, lc.comment, lc.created_at,
                    u.full_name as user_full_name
             FROM lead_comments lc
             INNER JOIN users u ON lc.user_id = u.id
             WHERE lc.lead_id = $1
             ORDER BY lc.created_at DESC`,
            [id]
        );

        const screeningResult = await pool.query(
            `SELECT * FROM phone_screening WHERE lead_id = $1`, [id]
        );

        const phoneScreening = screeningResult.rows.length > 0
            ? rowToCamelCase<PhoneScreening>(screeningResult.rows[0])
            : null;

        let invoiceData: InvoiceData | null = null;
        const invoiceResult = await pool.query(
            `SELECT * FROM invoice_data WHERE lead_id = $1`, [id]
        );

        if (invoiceResult.rows.length > 0) {
            const invoiceDataRow = invoiceResult.rows[0];
            const tariffsResult = await pool.query(
                `SELECT * FROM invoice_tariffs WHERE invoice_data_id = $1 ORDER BY created_at ASC`,
                [invoiceDataRow.id]
            );
            invoiceData = {
                id: invoiceDataRow.id,
                leadId: invoiceDataRow.lead_id,
                currentProviderType: invoiceDataRow.current_provider_type || null,
                currentProviderOther: invoiceDataRow.current_provider_other || null,
                deviceInstallmentsNote: invoiceDataRow.device_installments_note || null,
                contractEndDate: invoiceDataRow.contract_end_date || null,
                totalMonthly: parseFloat(invoiceDataRow.total_monthly) || 0,
                notes: invoiceDataRow.notes || null,
                analyzedAt: invoiceDataRow.analyzed_at,
                analyzedBy: invoiceDataRow.analyzed_by,
                createdAt: invoiceDataRow.created_at,
                updatedAt: invoiceDataRow.updated_at,
                tariffs: rowsToCamelCase<InvoiceTariff>(tariffsResult.rows),
            };
        }

        // AI call logs
        const aiCallLogsResult = await pool.query(
            `SELECT id, lead_id, call_sid, status, outcome, duration, transcript,
                    ai_notes, recording_url, recording_sid, started_at, completed_at, created_at
             FROM ai_call_logs
             WHERE lead_id = $1
             ORDER BY created_at DESC`,
            [id]
        );

        const aiCallLogs = rowsToCamelCase(aiCallLogsResult.rows);

        const comments = commentsResult.rows.map((row) => ({
            id: row.id,
            userId: row.user_id,
            userFullName: row.user_full_name,
            oldStatus: row.old_status,
            newStatus: row.new_status,
            comment: row.comment,
            createdAt: row.created_at,
        }));

        const lead: LeadDetailResponse = {
            id: leadRow.id,
            companyName: leadRow.company_name,
            legalForm: leadRow.legal_form,
            ico: leadRow.ico,
            contactPerson: leadRow.contact_person,
            phone: leadRow.phone,
            email: leadRow.email,
            status: leadRow.status,
            invoicePromised: leadRow.invoice_promised,
            assignedTo: leadRow.assigned_to.id ? leadRow.assigned_to : null,
            createdBy: leadRow.created_by,
            createdAt: leadRow.created_at,
            updatedAt: leadRow.updated_at,
            comments,
            phoneScreening,
            invoiceData,
            aiCallLogs,
        } as any;

        res.status(200).json({ lead });
    } catch (error) {
        next(error);
    }
};

export const createLead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const data = req.body as CreateLeadRequest;

        const result = await pool.query(
            `INSERT INTO leads (company_name, legal_form, ico, contact_person, phone, email,
                                status, assigned_to, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [data.companyName, data.legalForm || null, data.ico || null, data.contactPerson,
                data.phone, data.email, data.status || 'NOVY', data.assignedTo || null, req.user!.id]
        );

        const newLead = rowToCamelCase<Lead>(result.rows[0]);
        await logAuditAction(req.user!.id, 'LEAD_CREATED', req, newLead.id, { companyName: newLead.companyName });

        res.status(201).json({ lead: newLead });
    } catch (error) {
        next(error);
    }
};

export const updateLead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const data = req.body as UpdateLeadRequest;

        const leadCheck = await pool.query('SELECT id FROM leads WHERE id = $1', [id]);
        if (leadCheck.rows.length === 0) throw new NotFoundError('Lead not found');

        const fields: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (data.companyName !== undefined) { fields.push(`company_name = $${paramIndex}`); values.push(data.companyName); paramIndex++; }
        if (data.legalForm !== undefined) { fields.push(`legal_form = $${paramIndex}`); values.push(data.legalForm); paramIndex++; }
        if (data.ico !== undefined) { fields.push(`ico = $${paramIndex}`); values.push(data.ico); paramIndex++; }
        if (data.contactPerson !== undefined) { fields.push(`contact_person = $${paramIndex}`); values.push(data.contactPerson); paramIndex++; }
        if (data.phone !== undefined) { fields.push(`phone = $${paramIndex}`); values.push(data.phone); paramIndex++; }
        if (data.email !== undefined) { fields.push(`email = $${paramIndex}`); values.push(data.email); paramIndex++; }

        if (fields.length === 0) throw new BadRequestError('No fields to update');

        fields.push(`updated_at = NOW()`);
        values.push(id);

        const result = await pool.query(
            `UPDATE leads SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
            values
        );

        const updatedLead = rowToCamelCase<Lead>(result.rows[0]);
        res.status(200).json({ lead: updatedLead });
    } catch (error) {
        next(error);
    }
};

export const deleteLead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;

        const leadResult = await pool.query('SELECT id, company_name FROM leads WHERE id = $1', [id]);
        if (leadResult.rows.length === 0) throw new NotFoundError('Lead not found');

        await pool.query('DELETE FROM leads WHERE id = $1', [id]);
        await logAuditAction(req.user!.id, 'LEAD_DELETED', req, id, { companyName: leadResult.rows[0].company_name });

        res.status(200).json({ message: 'Lead deleted successfully' });
    } catch (error) {
        next(error);
    }
};

export const changeLeadStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const { status, comment, phoneScreening, invoicePromised } = req.body as ChangeLeadStatusRequest;

        const leadResult = await pool.query(
            'SELECT id, status, assigned_to, company_name FROM leads WHERE id = $1', [id]
        );
        if (leadResult.rows.length === 0) throw new NotFoundError('Lead not found');

        const lead = leadResult.rows[0];

        if (req.user!.role === 'SALES' && lead.assigned_to !== req.user!.id) {
            throw new ForbiddenError('You can only change status of your own leads');
        }

        const oldStatus = lead.status;

        await pool.query(
            'UPDATE leads SET status = $1, invoice_promised = $2, updated_at = NOW() WHERE id = $3',
            [status, invoicePromised || false, id]
        );

        await pool.query(
            `INSERT INTO lead_comments (lead_id, user_id, old_status, new_status, comment)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, req.user!.id, oldStatus, status, comment]
        );

        if (phoneScreening) {
            const existingScreening = await pool.query('SELECT id FROM phone_screening WHERE lead_id = $1', [id]);

            if (existingScreening.rows.length > 0) {
                await pool.query(
                    `UPDATE phone_screening SET
                        current_provider_type = $1, current_provider_other = $2,
                        monthly_total = $3, monthly_total_unknown = $4,
                        phone_count = $5, phone_count_unknown = $6,
                        phone_unlimited = $7, phone_unlimited_unknown = $8,
                        has_fixed_internet = $9, fixed_internet_count = $10,
                        fixed_internet_count_unknown = $11, has_mobile_internet = $12,
                        mobile_internet_count = $13, mobile_internet_count_unknown = $14,
                        has_tv = $15, tv_count = $16, tv_count_unknown = $17,
                        notes = $18, updated_at = NOW()
                     WHERE lead_id = $19`,
                    [
                        phoneScreening.currentProviderType || null, phoneScreening.currentProviderOther || null,
                        phoneScreening.monthlyTotal || null, phoneScreening.monthlyTotalUnknown || false,
                        phoneScreening.phoneCount || null, phoneScreening.phoneCountUnknown || false,
                        phoneScreening.phoneUnlimited || null, phoneScreening.phoneUnlimitedUnknown || false,
                        phoneScreening.hasFixedInternet || null, phoneScreening.fixedInternetCount || null,
                        phoneScreening.fixedInternetCountUnknown || false, phoneScreening.hasMobileInternet || null,
                        phoneScreening.mobileInternetCount || null, phoneScreening.mobileInternetCountUnknown || false,
                        phoneScreening.hasTv || null, phoneScreening.tvCount || null,
                        phoneScreening.tvCountUnknown || false, phoneScreening.notes || null, id,
                    ]
                );
            } else {
                await pool.query(
                    `INSERT INTO phone_screening (
                        lead_id, screened_by, current_provider_type, current_provider_other,
                        monthly_total, monthly_total_unknown, phone_count, phone_count_unknown,
                        phone_unlimited, phone_unlimited_unknown, has_fixed_internet, fixed_internet_count,
                        fixed_internet_count_unknown, has_mobile_internet, mobile_internet_count,
                        mobile_internet_count_unknown, has_tv, tv_count, tv_count_unknown, notes)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
                    [
                        id, req.user!.id,
                        phoneScreening.currentProviderType || null, phoneScreening.currentProviderOther || null,
                        phoneScreening.monthlyTotal || null, phoneScreening.monthlyTotalUnknown || false,
                        phoneScreening.phoneCount || null, phoneScreening.phoneCountUnknown || false,
                        phoneScreening.phoneUnlimited || null, phoneScreening.phoneUnlimitedUnknown || false,
                        phoneScreening.hasFixedInternet || null, phoneScreening.fixedInternetCount || null,
                        phoneScreening.fixedInternetCountUnknown || false, phoneScreening.hasMobileInternet || null,
                        phoneScreening.mobileInternetCount || null, phoneScreening.mobileInternetCountUnknown || false,
                        phoneScreening.hasTv || null, phoneScreening.tvCount || null,
                        phoneScreening.tvCountUnknown || false, phoneScreening.notes || null,
                    ]
                );
            }
        }

        res.status(200).json({ message: 'Lead status updated successfully', oldStatus, newStatus: status });
    } catch (error) {
        next(error);
    }
};

export const assignLead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const { assignedTo } = req.body as AssignLeadRequest;

        const leadResult = await pool.query(
            'SELECT id, company_name, assigned_to, status FROM leads WHERE id = $1', [id]
        );
        if (leadResult.rows.length === 0) throw new NotFoundError('Lead not found');

        const lead = leadResult.rows[0];

        let previousUserName: string | null = null;
        if (lead.assigned_to) {
            const prevUser = await pool.query('SELECT full_name FROM users WHERE id = $1', [lead.assigned_to]);
            if (prevUser.rows.length > 0) previousUserName = prevUser.rows[0].full_name;
        }

        let newAssignedUser: any = null;
        if (assignedTo) {
            const userResult = await pool.query('SELECT id, full_name, is_active FROM users WHERE id = $1', [assignedTo]);
            if (userResult.rows.length === 0) throw new NotFoundError('User not found');
            if (!userResult.rows[0].is_active) throw new BadRequestError('User is not active');
            newAssignedUser = userResult.rows[0];
        }

        await pool.query('UPDATE leads SET assigned_to = $1, updated_at = NOW() WHERE id = $2', [assignedTo || null, id]);

        const commentText = assignedTo && lead.assigned_to
            ? `🔄 Lead přeřazen z "${previousUserName}" na "${newAssignedUser.full_name}"`
            : assignedTo
                ? `👤 Lead přiřazen uživateli "${newAssignedUser.full_name}"`
                : `❌ Přiřazení leadu zrušeno`;

        await pool.query(
            `INSERT INTO lead_comments (lead_id, user_id, old_status, new_status, comment)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, req.user!.id, lead.status, lead.status, commentText]
        );

        res.status(200).json({
            message: assignedTo ? `Lead assigned to ${newAssignedUser.full_name}` : 'Lead unassigned',
            assignedTo: newAssignedUser ? { id: newAssignedUser.id, fullName: newAssignedUser.full_name } : null,
        });
    } catch (error) {
        next(error);
    }
};

export const skipLead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const { comment } = req.body as { comment: string };

        const leadResult = await pool.query('SELECT id, company_name, assigned_to FROM leads WHERE id = $1', [id]);
        if (leadResult.rows.length === 0) throw new NotFoundError('Lead not found');

        const lead = leadResult.rows[0];

        if (req.user!.role === 'SALES' && lead.assigned_to !== req.user!.id) {
            throw new ForbiddenError('You can only skip your own assigned leads');
        }

        await pool.query(
            `INSERT INTO lead_comments (lead_id, user_id, old_status, new_status, comment)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, req.user!.id, 'NOVY', 'NOVY', `Přeskočeno: ${comment}`]
        );

        await pool.query('UPDATE leads SET assigned_to = NULL, updated_at = NOW() WHERE id = $1', [id]);

        res.status(200).json({ message: 'Lead skipped and returned to pool', leadId: id });
    } catch (error) {
        next(error);
    }
};

export const updateLeadEmail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const { email } = req.body as { email: string };

        const leadResult = await pool.query(
            'SELECT id, email, assigned_to, status, company_name FROM leads WHERE id = $1', [id]
        );
        if (leadResult.rows.length === 0) throw new NotFoundError('Lead not found');

        const lead = leadResult.rows[0];

        if (req.user!.role === 'SALES' && lead.assigned_to !== req.user!.id) {
            throw new ForbiddenError('You can only update your own leads');
        }

        const oldEmail = lead.email;
        await pool.query('UPDATE leads SET email = $1, updated_at = NOW() WHERE id = $2', [email, id]);

        await pool.query(
            `INSERT INTO lead_comments (lead_id, user_id, old_status, new_status, comment)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, req.user!.id, lead.status, lead.status, `📧 Email změněn z "${oldEmail}" na "${email}"`]
        );

        res.status(200).json({ message: 'Email updated successfully', oldEmail, newEmail: email });
    } catch (error) {
        next(error);
    }
};