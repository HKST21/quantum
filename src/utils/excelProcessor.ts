import { BadRequestError } from './errors';

const XLSX = require('xlsx');

export const processVodafoneExcel = async (buffer: Buffer): Promise<string[]> => {
    try {
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) throw new BadRequestError('Excel soubor neobsahuje žádný list');

        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

        if (data.length === 0) throw new BadRequestError('Excel soubor je prázdný');

        const icos: string[] = [];
        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            if (!row || row.length === 0) continue;
            const normalizedIco = String(row[0]).replace(/\s+/g, '').trim();
            if (/^\d{8}$/.test(normalizedIco)) icos.push(normalizedIco);
        }

        if (icos.length === 0) throw new BadRequestError('V souboru nebyly nalezeny žádné platné IČO');

        return icos;
    } catch (error) {
        if (error instanceof BadRequestError) throw error;
        throw new BadRequestError('Chyba při zpracování Excel souboru');
    }
};