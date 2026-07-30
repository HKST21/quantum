import axios, { AxiosError } from 'axios';
import { createAlertThrottled } from '../../services/alertsService';

// ============================================================================
// ODORIK SERVICE
// ============================================================================
//
// HTTP klient pro Odorik Public Numbers API.
//
// Autentizace: user + password jako form parametry (ne HTTP Basic Auth!).
// Odorik API očekává credentials přímo v POST body / query stringu.
// Ověřeno v oficiálních PHP/Ruby příkladech od Odoriku.
//
// Dokumentace: https://www.odorik.cz/w/api:public_numbers
//
// Při chybách vytváří alerty přes alertsService (throttled aby nespammoval).
// ============================================================================

const ODORIK_API_BASE_URL = 'https://www.odorik.cz/api/v1';

export class OdorikService {
    private apiUser: string;
    private apiPassword: string;

    constructor() {
        this.apiUser = process.env.ODORIK_API_USER || '';
        this.apiPassword = process.env.ODORIK_API_PASSWORD || '';

        if (!this.apiUser || !this.apiPassword) {
            console.warn('⚠️ Odorik API credentials not configured (ODORIK_API_USER, ODORIK_API_PASSWORD)');
        } else {
            console.log('✅ OdorikService initialized');
        }
    }

    /**
     * Konvertuje český telefonní číslo do Odorik formátu s prefixem *087.
     *
     * Vstup: '+420703034160' nebo '00420703034160' nebo '703034160'
     * Výstup: '*08700420703034160' (prefix *087 + mezinárodní formát BEZ +)
     */
    private formatRingingNumber(phoneNumber: string): string {
        let cleaned = phoneNumber.replace(/[\s\-()+ ]/g, '');

        if (cleaned.startsWith('420')) {
            cleaned = '00' + cleaned;
        } else if (cleaned.match(/^\d{9}$/)) {
            cleaned = '00420' + cleaned;
        } else if (!cleaned.startsWith('00')) {
            cleaned = '00420' + cleaned;
        }

        return `*087${cleaned}`;
    }

    private formatPublicNumber(sipName: string): string {
        return sipName;
    }

    /**
     * Získá aktuální seznam routes pro SIP jméno.
     */
    async getRoutes(sipName: string): Promise<any[]> {
        if (!this.apiUser || !this.apiPassword) {
            throw new Error('Odorik API credentials not configured');
        }

        const publicNumber = this.formatPublicNumber(sipName);
        const url = `${ODORIK_API_BASE_URL}/public_numbers/${publicNumber}/routes.json`;

        try {
            const response = await axios.get(url, {
                params: {
                    user: this.apiUser,
                    password: this.apiPassword,
                },
                timeout: 10000,
            });

            if (Array.isArray(response.data)) {
                return response.data;
            }

            if (response.data && response.data.errors) {
                console.error(`❌ Odorik API errors:`, response.data.errors);
                await createAlertThrottled({
                    type: 'ODORIK_API_ERROR',
                    message: `Odorik API vrátilo chyby při getRoutes: ${JSON.stringify(response.data.errors)}`,
                    severity: 'error',
                    metadata: { sipName, errors: response.data.errors },
                });
                return [];
            }

            console.warn(`⚠️ Unexpected getRoutes response for ${sipName}:`, response.data);
            return [];
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error(`❌ Odorik getRoutes failed for ${sipName}:`, {
                status: axiosError.response?.status,
                data: axiosError.response?.data,
                message: axiosError.message,
            });

            await createAlertThrottled({
                type: 'ODORIK_API_ERROR',
                message: `Odorik API selhalo při getRoutes pro ${sipName}: ${axiosError.message}`,
                severity: 'error',
                metadata: { sipName, status: axiosError.response?.status },
            });

            throw new Error(`Odorik API error: ${axiosError.message}`);
        }
    }

    /**
     * Smaže konkrétní route podle ID.
     */
    async deleteRoute(sipName: string, routeId: number | string): Promise<boolean> {
        if (!this.apiUser || !this.apiPassword) {
            throw new Error('Odorik API credentials not configured');
        }

        const publicNumber = this.formatPublicNumber(sipName);
        const url = `${ODORIK_API_BASE_URL}/public_numbers/${publicNumber}/routes/${routeId}.json`;

        try {
            await axios.delete(url, {
                params: {
                    user: this.apiUser,
                    password: this.apiPassword,
                },
                timeout: 10000,
            });

            console.log(`🗑️ Odorik route deleted: ${sipName}/${routeId}`);
            return true;
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error(`❌ Odorik deleteRoute failed for ${sipName}/${routeId}:`, axiosError.message);
            return false;
        }
    }

    /**
     * Smaže VŠECHNY existující routes na SIP jménu.
     */
    async deleteAllRoutes(sipName: string): Promise<void> {
        try {
            const routes = await this.getRoutes(sipName);

            if (!Array.isArray(routes) || routes.length === 0) {
                console.log(`ℹ️ No existing routes on ${sipName} to delete`);
                return;
            }

            console.log(`🧹 Cleaning up ${routes.length} existing routes on ${sipName}`);

            for (const route of routes) {
                if (route && route.id) {
                    await this.deleteRoute(sipName, route.id);
                }
            }
        } catch (error) {
            console.error(`⚠️ deleteAllRoutes error for ${sipName}:`, error);
        }
    }

    /**
     * Nastaví dynamické přesměrování SIP jména na cílové telefonní číslo.
     */
    async setForward(sipName: string, targetPhone: string): Promise<boolean> {
        if (!this.apiUser || !this.apiPassword) {
            throw new Error('Odorik API credentials not configured');
        }

        await this.deleteAllRoutes(sipName);

        const publicNumber = this.formatPublicNumber(sipName);
        const ringingNumber = this.formatRingingNumber(targetPhone);

        const url = `${ODORIK_API_BASE_URL}/public_numbers/${publicNumber}/routes.json`;

        console.log(`📡 Setting Odorik forward: ${sipName} → ${ringingNumber}`);

        try {
            const response = await axios.post(
                url,
                new URLSearchParams({
                    user: this.apiUser,
                    password: this.apiPassword,
                    source_number: '*',
                    ringing_number: ringingNumber,
                }).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    timeout: 10000,
                }
            );

            console.log(`✅ Odorik forward set: ${sipName} → ${ringingNumber}`, {
                status: response.status,
                data: response.data,
            });

            return true;
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error(`❌ Odorik setForward failed for ${sipName}:`, {
                status: axiosError.response?.status,
                data: axiosError.response?.data,
                message: axiosError.message,
            });

            await createAlertThrottled({
                type: 'ODORIK_API_ERROR',
                message: `Odorik API selhalo při setForward pro ${sipName}: ${axiosError.message}`,
                severity: 'error',
                metadata: { sipName, targetPhone, status: axiosError.response?.status },
            });

            throw new Error(`Odorik API error: ${axiosError.message}`);
        }
    }
}

export const odorikService = new OdorikService();