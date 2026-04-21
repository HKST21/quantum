import { Request, Response, NextFunction } from 'express';
import { logAuditAction } from '../middleware/auditLog';
import { BadRequestError } from '../utils/errors';
import { parseExcelFile, validateLeads, bulkInsertLeads, validateUserExists } from '../utils/leadImportProcessor';
import { LeadsImportSuccessResponse, LeadsImportFailedResponse } from '../types/leadsImport.types';

export const importLeads = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const startTime = Date.now();

        if (!req.file) throw new BadRequestError('Excel soubor nebyl nahrán');

        console.log('📤 Leads Import started by:', req.user?.fullName);

        const globalAssignedTo = req.body.assignedTo as string | undefined;
        const createdBy = req.user!.id;

        if (globalAssignedTo) {
            const userExists = await validateUserExists(globalAssignedTo);
            if (!userExists) throw new BadRequestError(`Uživatel s ID ${globalAssignedTo} neexistuje`);
        }

        const parseResult = parseExcelFile(req.file.buffer);
        console.log(`✅ Parsed ${parseResult.totalRows} rows`);

        const validationResult = await validateLeads(parseResult.rows, globalAssignedTo || null, createdBy);

        if (validationResult.missingAssignments.length > 0) {
            const response: LeadsImportFailedResponse = {
                success: false,
                error: 'MISSING_ASSIGNMENT',
                message: 'Vyberte uživatele pro přiřazení nebo vyplňte sloupec assigned_to v Excelu',
                details: { rowsWithoutAssignment: validationResult.missingAssignments.slice(0, 100) },
            };
            res.status(400).json(response);
            return;
        }

        if (validationResult.validLeads.length === 0) {
            res.status(200).json({
                success: true,
                summary: { totalRows: parseResult.totalRows, inserted: 0, duplicates: validationResult.duplicates.length, errors: validationResult.errors.length },
                duplicates: validationResult.duplicates.slice(0, 1000),
                errors: validationResult.errors.slice(0, 1000),
            });
            return;
        }

        const insertResult = await bulkInsertLeads(validationResult.validLeads);
        const additionalDuplicates = insertResult.failedIcos.map(ico => {
            const lead = validationResult.validLeads.find(l => l.ico === ico);
            return { row: 0, ico, company: lead?.companyName || 'Unknown' };
        });

        const allDuplicates = [...validationResult.duplicates, ...additionalDuplicates];
        const duration = (Date.now() - startTime) / 1000;

        await logAuditAction(req.user!.id, 'DATA_IMPORTED', req, null, {
            action: 'leads_import_success',
            fileName: req.file.originalname,
            totalRows: parseResult.totalRows,
            inserted: insertResult.inserted,
            duplicates: allDuplicates.length,
            errors: validationResult.errors.length,
            durationSeconds: duration,
        });

        const response: LeadsImportSuccessResponse = {
            success: true,
            summary: {
                totalRows: parseResult.totalRows,
                inserted: insertResult.inserted,
                duplicates: allDuplicates.length,
                errors: validationResult.errors.length,
            },
            duplicates: allDuplicates.slice(0, 1000),
            errors: validationResult.errors.slice(0, 1000),
        };

        res.status(200).json(response);
    } catch (error: any) {
        console.error('❌ Leads import error:', error);
        next(error);
    }
};