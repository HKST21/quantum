import { Request, Response, NextFunction } from 'express';
import pool, { rowToCamelCase } from '../db/pool';
import { logAuditAction } from '../middleware/auditLog';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { PhoneScreening, PhoneScreeningRequest } from '../types';

export const getPhoneScreening = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;

        const leadResult = await pool.query('SELECT id, assigned_to FROM leads WHERE id = $1', [id]);
        if (leadResult.rows.length === 0) throw new NotFoundError('Lead not found');

        const lead = leadResult.rows[0];
        if (req.user!.role === 'SALES' && lead.assigned_to !== req.user!.id) {
            throw new ForbiddenError('You can only access screening for your assigned leads');
        }

        const screeningResult = await pool.query(
            `SELECT * FROM phone_screening WHERE lead_id = $1`, [id]
        );

        if (screeningResult.rows.length === 0) {
            res.status(200).json({ screening: null });
            return;
        }

        const screening = rowToCamelCase<PhoneScreening>(screeningResult.rows[0]);
        res.status(200).json({ screening });
    } catch (error) {
        next(error);
    }
};

export const createOrUpdatePhoneScreening = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const data = req.body as PhoneScreeningRequest;

        const leadResult = await pool.query('SELECT id, assigned_to, company_name FROM leads WHERE id = $1', [id]);
        if (leadResult.rows.length === 0) throw new NotFoundError('Lead not found');

        const lead = leadResult.rows[0];
        if (req.user!.role === 'SALES' && lead.assigned_to !== req.user!.id) {
            throw new ForbiddenError('You can only edit screening for your assigned leads');
        }

        const existingResult = await pool.query('SELECT id FROM phone_screening WHERE lead_id = $1', [id]);
        const isUpdate = existingResult.rows.length > 0;

        const values = [
            data.currentProviderType || null, data.currentProviderOther || null,
            data.monthlyTotal || null, data.monthlyTotalUnknown || false,
            data.phoneCount || null, data.phoneCountUnknown || false,
            data.phoneUnlimited || null, data.phoneUnlimitedUnknown || false,
            data.hasFixedInternet || null, data.fixedInternetCount || null,
            data.fixedInternetCountUnknown || false, data.hasMobileInternet || null,
            data.mobileInternetCount || null, data.mobileInternetCountUnknown || false,
            data.hasTv || null, data.tvCount || null,
            data.tvCountUnknown || false, data.notes || null,
        ];

        let result;
        if (isUpdate) {
            result = await pool.query(
                `UPDATE phone_screening SET
                    current_provider_type=$1, current_provider_other=$2,
                    monthly_total=$3, monthly_total_unknown=$4,
                    phone_count=$5, phone_count_unknown=$6,
                    phone_unlimited=$7, phone_unlimited_unknown=$8,
                    has_fixed_internet=$9, fixed_internet_count=$10,
                    fixed_internet_count_unknown=$11, has_mobile_internet=$12,
                    mobile_internet_count=$13, mobile_internet_count_unknown=$14,
                    has_tv=$15, tv_count=$16, tv_count_unknown=$17,
                    notes=$18, updated_at=NOW()
                 WHERE lead_id=$19 RETURNING *`,
                [...values, id]
            );
        } else {
            result = await pool.query(
                `INSERT INTO phone_screening (
                    lead_id, screened_by,
                    current_provider_type, current_provider_other,
                    monthly_total, monthly_total_unknown,
                    phone_count, phone_count_unknown,
                    phone_unlimited, phone_unlimited_unknown,
                    has_fixed_internet, fixed_internet_count,
                    fixed_internet_count_unknown, has_mobile_internet,
                    mobile_internet_count, mobile_internet_count_unknown,
                    has_tv, tv_count, tv_count_unknown, notes)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
                 RETURNING *`,
                [id, req.user!.id, ...values]
            );
        }

        const screening = rowToCamelCase<PhoneScreening>(result.rows[0]);

        await logAuditAction(req.user!.id, 'LEAD_UPDATED', req, id, {
            action: isUpdate ? 'screening_updated' : 'screening_created',
            companyName: lead.company_name,
        });

        res.status(isUpdate ? 200 : 201).json({
            screening,
            message: isUpdate ? 'Screening updated successfully' : 'Screening created successfully',
        });
    } catch (error) {
        next(error);
    }
};