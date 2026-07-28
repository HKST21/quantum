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
//   2. Odorik API nastaví: sip:hejda_test1@sip.odorik.cz → přesměruj na *087+420703034160
//      (prefix *087 zajistí přenos správného CLIP = Hejdovo mobilní 703614594)
//   3. Backend zavolá Twilio: client.calls.create({ to: 'sip:hejda_test1@sip.odorik.cz' })
//   4. Odorik přijme INVITE na SIP jméno, přesměruje na cílové číslo s správným CLIP
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
     * Výstup: '*087+420703034160' (prefix *087 zajistí přenos CLIP)
     *
     * Petr Soukup: "Aby se přeneslo správně číslo volajícího, tak volané číslo
     * vkládejte s prefixem *087cislo. Tím se převezme id volající linky."
     */
    private formatRingingNumber(phoneNumber: string): string {
        // Odstraníme mezery a pomlčky
        let cleaned = phoneNumber.replace(/[\s\-()]/g, '');

        // Normalizace na +420 formát
        if (cleaned.startsWith('00420')) {
            cleaned = '+' + cleaned.slice(2);
        } else if (cleaned.startsWith('420') && !cleaned.startsWith('+420')) {
            cleaned = '+' + cleaned;
        } else if (cleaned.match(/^\d{9}$/)) {
            cleaned = '+420' + cleaned;
        }

        return `*087${cleaned}`;
    }

    /**
     * Konvertuje SIP jméno do Odorik "veřejného čísla" formátu pro API.
     * SIP jména se pro API používají stejně jako veřejná telefonní čísla.
     *
     * Vstup: 'hejda_test1'
     * Výstup: 'hejda_test1' (pro SIP jména není potřeba prefix 00420)
     */
    private formatPublicNumber(sipName: string): string {
        return sipName;
    }

    /**
     * Nastaví dynamické přesměrování SIP jména na cílové telefonní číslo.
     * Použije parametr replace_by_source_number=true → Odorik automaticky
     * odstraní všechna předchozí přesměrování se source_number="*", takže
     * není potřeba nejdřív dělat DELETE.
     *
     * @param sipName - Odorik SIP jméno (např. 'hejda_test1')
     * @param targetPhone - Cílové telefonní číslo klienta (např. '+420703034160')
     * @returns true když se přesměrování úspěšně nastaví
     */
    async setForward(sipName: string, targetPhone: string): Promise<boolean> {
        if (!this.apiUser || !this.apiPassword) {
            throw new Error('Odorik API credentials not configured');
        }

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
                    replace_by_source_number: 'true',
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

    /**
     * Získá aktuální seznam přesměrování pro SIP jméno (debug/monitoring).
     */
    async getRoutes(sipName: string): Promise<any[]> {
        if (!this.apiUser || !this.apiPassword) {
            throw new Error('Odorik API credentials not configured');
        }

        const publicNumber = this.formatPublicNumber(sipName);
        const url = `${ODORIK_API_BASE_URL}/public_numbers/${publicNumber}/routes.json`;

        try {
            const response = await axios.get(url, {
                auth: {
                    username: this.apiUser,
                    password: this.apiPassword,
                },
                timeout: 10000,
            });

            return response.data || [];
        } catch (error) {
            const axiosError = error as AxiosError;
            console.error(`❌ Odorik getRoutes failed for ${sipName}:`, axiosError.message);
            throw new Error(`Odorik API error: ${axiosError.message}`);
        }
    }
}

export const odorikService = new OdorikService();