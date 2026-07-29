import axios, { AxiosError } from 'axios';

// ============================================================================
// ODORIK SERVICE
// ============================================================================
//
// HTTP klient pro Odorik Public Numbers API.
//
// Účel: Před každým Twilio hovorem přes Odorik BYOC trunk musíme dynamicky
// nastavit SIP jméno tak, aby přesměrovávalo na cílové číslo klienta.
//
// Flow:
//   1. Backend zavolá setForward('hejda_test1', '+420703034160')
//   2. Odorik API: DELETE všech existujících routes na SIP jménu
//   3. Odorik API: POST nový route → sip:hejda_test1@sip.odorik.cz přesměruj na
//      *08700420703034160 (prefix *087 + 00420 formát zajistí správný CLIP)
//   4. Backend zavolá Twilio: client.calls.create({ to: 'sip:hejda_test1@sip.odorik.cz' })
//   5. Odorik přijme INVITE na SIP jméno, přesměruje na cílové číslo s CLIPem
//
// Autentizace: HTTP Basic Auth (API user + heslo z ENV proměnných)
// Dokumentace: https://www.odorik.cz/w/api:public_numbers
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
     *
     * Petr Soukup: "Aby se přeneslo správně číslo volajícího, tak volané číslo
     * vkládejte s prefixem *087cislo. Doporučuji přesměrovat na *08700420737007770
     * nebo *087737007770 nikoli na variantu s + ta nevím jestli je ošetřená."
     */
    private formatRingingNumber(phoneNumber: string): string {
        // Odstraníme mezery, pomlčky a všechny + znaky
        let cleaned = phoneNumber.replace(/[\s\-()+ ]/g, '');

        // Normalizace na 00420 formát (bez + na začátku)
        if (cleaned.startsWith('420')) {
            cleaned = '00' + cleaned; // 420... → 00420...
        } else if (cleaned.match(/^\d{9}$/)) {
            cleaned = '00420' + cleaned; // 9 číslic → 00420 + číslo
        } else if (!cleaned.startsWith('00')) {
            // Pokud nezačíná ani 420 ani 00, přidáme 00420 (fallback pro české čísla)
            cleaned = '00420' + cleaned;
        }

        return `*087${cleaned}`;
    }

    /**
     * Konvertuje SIP jméno do Odorik "veřejného čísla" formátu pro API.
     * SIP jména se pro API používají stejně jako veřejná telefonní čísla.
     */
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
                auth: { username: this.apiUser, password: this.apiPassword },
                timeout: 10000,
            });

            return response.data || [];
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error(`❌ Odorik getRoutes failed for ${sipName}:`, axiosError.message);
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
                auth: { username: this.apiUser, password: this.apiPassword },
                timeout: 10000,
            });

            console.log(`🗑️ Odorik route deleted: ${sipName}/${routeId}`);
            return true;
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error(`❌ Odorik deleteRoute failed for ${sipName}/${routeId}:`, axiosError.message);
            return false; // Nechceme aby jednorázová chyba shodila celý flow
        }
    }

    /**
     * Smaže VŠECHNY existující routes na SIP jménu.
     * Volá se před přidáním nového route, aby se předešlo paralelnímu zvonění
     * na stará čísla (Petrovo číslo z předchozích testů apod.).
     */
    async deleteAllRoutes(sipName: string): Promise<void> {
        try {
            const routes = await this.getRoutes(sipName);

            if (routes.length === 0) {
                console.log(`ℹ️ No existing routes on ${sipName} to delete`);
                return;
            }

            console.log(`🧹 Cleaning up ${routes.length} existing routes on ${sipName}`);

            for (const route of routes) {
                if (route.id) {
                    await this.deleteRoute(sipName, route.id);
                }
            }
        } catch (error) {
            console.error(`⚠️ deleteAllRoutes error for ${sipName}:`, error);
            // Pokračujeme - pokud DELETE selže, POST route stále přidá nový
        }
    }

    /**
     * Nastaví dynamické přesměrování SIP jména na cílové telefonní číslo.
     * Nejdřív smaže všechny existující routes, pak přidá nový.
     *
     * @param sipName - Odorik SIP jméno (např. 'hejda_test1')
     * @param targetPhone - Cílové telefonní číslo klienta (např. '+420703034160')
     * @returns true když se přesměrování úspěšně nastaví
     */
    async setForward(sipName: string, targetPhone: string): Promise<boolean> {
        if (!this.apiUser || !this.apiPassword) {
            throw new Error('Odorik API credentials not configured');
        }

        // KROK 1: Smaž všechny existující routes (Petrovo přesměrování atd.)
        await this.deleteAllRoutes(sipName);

        // KROK 2: Přidej nový route na cílové číslo
        const publicNumber = this.formatPublicNumber(sipName);
        const ringingNumber = this.formatRingingNumber(targetPhone);

        const url = `${ODORIK_API_BASE_URL}/public_numbers/${publicNumber}/routes.json`;

        console.log(`📡 Setting Odorik forward: ${sipName} → ${ringingNumber}`);

        try {
            const response = await axios.post(
                url,
                new URLSearchParams({
                    source_number: '*',
                    ringing_number: ringingNumber,
                }).toString(),
                {
                    auth: {
                        username: this.apiUser,
                        password: this.apiPassword,
                    },
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    timeout: 10000,
                }
            );

            console.log(`✅ Odorik forward set: ${sipName} → ${ringingNumber}`, {
                status: response.status,
            });

            return true;
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error(`❌ Odorik setForward failed for ${sipName}:`, {
                status: axiosError.response?.status,
                data: axiosError.response?.data,
                message: axiosError.message,
            });
            throw new Error(`Odorik API error: ${axiosError.message}`);
        }
    }
}

export const odorikService = new OdorikService();