import { Request, Response, NextFunction } from 'express';
import pool, { rowToCamelCase, rowsToCamelCase } from '../db/pool';
import { logAuditAction } from '../middleware/auditLog';
import { BadRequestError, NotFoundError, ForbiddenError } from '../utils/errors';
import { InvoiceData, InvoiceTariff, InvoiceDataRequest } from '../types';

export const getInvoiceData = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;

        const leadResult = await pool.query('SELECT id, assigned_to FROM leads WHERE id = $1', [id]);
        if (leadResult.rows.length === 0) throw new NotFoundError('Lead not found');

        const lead = leadResult.rows[0];
        if (req.user!.role === 'SALES' && lead.assigned_to !== req.user!.id) {
            throw new ForbiddenError('You can only access invoice for your assigned leads');
        }

        const invoiceResult = await pool.query(
            `SELECT * FROM invoice_data WHERE lead_id = $1`, [id]
        );

        if (invoiceResult.rows.length === 0) {
            res.status(200).json({ invoice: null });
            return;
        }

        const invoiceDataRow = invoiceResult.rows[0];
        const tariffsResult = await pool.query(
            `SELECT * FROM invoice_tariffs WHERE invoice_data_id = $1 ORDER BY created_at ASC`,
            [invoiceDataRow.id]
        );

        const invoiceData: InvoiceData = {
            ...rowToCamelCase(invoiceDataRow),
            tariffs: rowsToCamelCase<InvoiceTariff>(tariffsResult.rows),
        };

        res.status(200).json({ invoice: invoiceData });
    } catch (error) {
        next(error);
    }
};

export const createOrUpdateInvoiceData = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const data = req.body as InvoiceDataRequest;

        const leadResult = await pool.query('SELECT id, assigned_to, company_name FROM leads WHERE id = $1', [id]);
        if (leadResult.rows.length === 0) throw new NotFoundError('Lead not found');

        const lead = leadResult.rows[0];
        if (req.user!.role === 'SALES' && lead.assigned_to !== req.user!.id) {
            throw new ForbiddenError('You can only edit invoice for your assigned leads');
        }

        for (const tariff of data.tariffs) {
            const calculatedTotal = tariff.unitPrice * tariff.quantity;
            if (Math.abs(tariff.totalPrice - calculatedTotal) > 0.01) {
                throw new BadRequestError(`Invalid calculation for tariff "${tariff.tariffName}"`);
            }
        }

        const existingResult = await pool.query('SELECT id FROM invoice_data WHERE lead_id = $1', [id]);
        const isUpdate = existingResult.rows.length > 0;

        let invoiceDataId: string;

        if (isUpdate) {
            invoiceDataId = existingResult.rows[0].id;
            await pool.query(
                `UPDATE invoice_data SET
                    current_provider_type=$1, current_provider_other=$2,
                    device_installments_note=$3, contract_end_date=$4,
                    notes=$5, updated_at=NOW()
                 WHERE id=$6`,
                [
                    data.currentProviderType || null, data.currentProviderOther || null,
                    data.deviceInstallmentsNote || null, data.contractEndDate || null,
                    data.notes || null, invoiceDataId,
                ]
            );
            await pool.query('DELETE FROM invoice_tariffs WHERE invoice_data_id = $1', [invoiceDataId]);
        } else {
            const result = await pool.query(
                `INSERT INTO invoice_data (lead_id, analyzed_by, current_provider_type, current_provider_other,
                    device_installments_note, contract_end_date, notes)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
                [
                    id, req.user!.id,
                    data.currentProviderType || null, data.currentProviderOther || null,
                    data.deviceInstallmentsNote || null, data.contractEndDate || null,
                    data.notes || null,
                ]
            );
            invoiceDataId = result.rows[0].id;
        }

        for (const tariff of data.tariffs) {
            await pool.query(
                `INSERT INTO invoice_tariffs (invoice_data_id, tariff_name, unit_price, quantity, total_price, notes)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [invoiceDataId, tariff.tariffName, tariff.unitPrice, tariff.quantity, tariff.totalPrice, tariff.notes || null]
            );
        }

        const totalMonthly = data.tariffs.reduce((sum, t) => sum + t.totalPrice, 0);
        await pool.query('UPDATE invoice_data SET total_monthly = $1 WHERE id = $2', [totalMonthly, invoiceDataId]);

        await logAuditAction(req.user!.id, 'LEAD_UPDATED', req, id, {
            action: isUpdate ? 'invoice_updated' : 'invoice_created',
            companyName: lead.company_name,
        });

        const invoiceResult = await pool.query(`SELECT * FROM invoice_data WHERE id = $1`, [invoiceDataId]);
        const tariffsResult = await pool.query(
            `SELECT * FROM invoice_tariffs WHERE invoice_data_id = $1 ORDER BY created_at ASC`,
            [invoiceDataId]
        );

        const invoiceData: InvoiceData = {
            ...rowToCamelCase(invoiceResult.rows[0]),
            tariffs: rowsToCamelCase<InvoiceTariff>(tariffsResult.rows),
        };

        res.status(isUpdate ? 200 : 201).json({
            invoice: invoiceData,
            message: isUpdate ? 'Invoice updated successfully' : 'Invoice created successfully',
        });
    } catch (error) {
        next(error);
    }
};

export const deleteTariff = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id, tariffId } = req.params;

        const tariffResult = await pool.query(
            `SELECT it.id, it.invoice_data_id, it.tariff_name, id2.lead_id, l.assigned_to
             FROM invoice_tariffs it
             INNER JOIN invoice_data id2 ON it.invoice_data_id = id2.id
             INNER JOIN leads l ON id2.lead_id = l.id
             WHERE it.id = $1 AND l.id = $2`,
            [tariffId, id]
        );

        if (tariffResult.rows.length === 0) throw new NotFoundError('Tariff not found');

        const tariff = tariffResult.rows[0];
        if (req.user!.role === 'SALES' && tariff.assigned_to !== req.user!.id) {
            throw new ForbiddenError('You can only delete tariffs for your assigned leads');
        }

        await pool.query('DELETE FROM invoice_tariffs WHERE id = $1', [tariffId]);

        const totalResult = await pool.query(
            `SELECT COALESCE(SUM(total_price), 0) as total FROM invoice_tariffs WHERE invoice_data_id = $1`,
            [tariff.invoice_data_id]
        );

        const totalMonthly = parseFloat(totalResult.rows[0].total);
        await pool.query(
            'UPDATE invoice_data SET total_monthly = $1, updated_at = NOW() WHERE id = $2',
            [totalMonthly, tariff.invoice_data_id]
        );

        res.status(200).json({ message: 'Tariff deleted successfully', newTotal: totalMonthly });
    } catch (error) {
        next(error);
    }
};