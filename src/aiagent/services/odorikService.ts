import axios, { AxiosError } from 'axios';
import { createAlertThrottled } from '../../services/alertsService';
import { OdorikLine } from '../types/aiCalls.types';

// ============================================================================
// ODORIK SERVICE
// ============================================================================
//
// HTTP klient pro Odorik Public Numbers API.
//
// Autentizace: user + password jako form parametry (ne HTTP Basic Auth!).
// Odorik API očekává credentials přímo v POST body / query stringu.
//
// Dokumentace: https://www.odorik.cz/w/api:public_numbers
//
// Při chybách vytváří alerty přes alertsService (throttled aby nespammoval).
//
// ⚠️ (21.9.2026) — DVĚ ODORIK LINKY (mobilní 790766, pevná 793305):
//   Obě sdílejí STEJNÝ Twilio BYOC trunk. Liší se jen "from" číslo (CLIP)
//   a sada SIP jmen.
//
// ⚠️ (24.9.2026) — TŘETÍ SKUPINA: FB linky (7× samostatná pevná linka,
//   KAŽDÁ S VLASTNÍM CLIP — na rozdíl od mobilní/pevné skupiny, kde
//   všechny SIP jména ve skupině sdílejí jedno společné CLIP). To
//   vyžaduje nový model — "identita" jako pár (sipName, fromNumber),
//   ne odděleně "seznam SIP jmen" + "jedno sdílené číslo". Viz
//   getIdentitiesForLine() níže. Stávající getActiveSipNames() /
//   getPhoneNumberForLine() zůstávají BEZE ZMĚNY (pro mobilní/pevnou
//   linku je pořád validní model "N jmen, 1 sdílené číslo") —
//   getIdentitiesForLine() je nadstavba, která je pro tyhle dvě
//   skupiny z nich sama sestaví ekvivalentní identity, a pro 'fb'
//   čte nové párované ENV proměnné.
//
// ⚠️ OPRAVA (21.9.2026) — setForward() dřív logoval "✅ Odorik forward
//   set" jen podle HTTP statusu 200, i když response.data obsahovalo
//   { errors: [...] } (Odorik API vrací chybu s HTTP 200, ne s chybovým
//   statusem). Teď se response.data.errors kontroluje explicitně.
// ============================================================================

const ODORIK_API_BASE_URL = 'https://www.odorik.cz/api/v1';

// ⚠️ NOVÉ (24.9.2026) — jedna identita = jedno SIP jméno + jeho VLASTNÍ
// "from" číslo. Pro mobilní/pevnou linku mají všechny identity ve
// skupině stejné fromNumber (degenerovaný případ). Pro FB skupinu má
// každá identita jiné fromNumber.
export interface OdorikIdentity {
    sipName: string;
    fromNumber: string;
}

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
     * Vrátí seznam aktivně nakonfigurovaných Odorik SIP jmen z ENV pro
     * danou linku. Čte ODORIK_SIP_NAME_1, _2... (mobilní linka),
     * ODORIK_PEVNA_SIP_NAME_1, _2... (pevná linka), nebo
     * ODORIK_FB_SIP_NAME_1, _2... (FB linky), dokud nenarazí na mezeru.
     *
     * JEDINÝ zdroj pravdy pro to, kolik Odorik workerů je k dispozici
     * pro danou linku/skupinu. Do ENV se smí dávat POUZE SIP jména
     * schválená Odorik/T-Mobile — tenhle seznam se bere jako závazný.
     *
     * ⚠️ Pro 'fb' vrací jen jména (bez jejich CLIP) — pokud potřebuješ
     * i CLIP, použij getIdentitiesForLine('fb'), ne tuhle metodu.
     */
    getActiveSipNames(line: OdorikLine = 'mobilni'): string[] {
        const prefix = line === 'pevna'
            ? 'ODORIK_PEVNA_SIP_NAME_'
            : line === 'fb'
                ? 'ODORIK_FB_SIP_NAME_'
                : 'ODORIK_SIP_NAME_';
        const sipNames: string[] = [];
        let i = 1;
        while (true) {
            const name = process.env[`${prefix}${i}`];
            if (!name) break;
            sipNames.push(name);
            i++;
        }
        return sipNames;
    }

    /**
     * Vrátí "from" telefonní číslo (CLIP) pro danou linku. Mobilní
     * linka (790766) → ODORIK_PHONE_NUMBER. Pevná linka (793305) →
     * ODORIK_PEVNA_PHONE_NUMBER.
     *
     * ⚠️ NEPOUŽÍVAT pro 'fb' — FB skupina nemá jedno sdílené CLIP,
     * každá identita má vlastní (viz getIdentitiesForLine). Volání
     * s line='fb' vrátí prázdný string.
     */
    getPhoneNumberForLine(line: OdorikLine = 'mobilni'): string {
        if (line === 'fb') {
            console.warn('⚠️ getPhoneNumberForLine() zavoláno s line=fb — FB skupina nemá sdílené CLIP, použij getIdentitiesForLine(\'fb\')');
            return '';
        }
        return line === 'pevna'
            ? process.env.ODORIK_PEVNA_PHONE_NUMBER || ''
            : process.env.ODORIK_PHONE_NUMBER || '';
    }

    /**
     * ⚠️ NOVÉ (24.9.2026) — vrátí kompletní seznam identit (SIP jméno +
     * VLASTNÍ from-číslo) pro danou linku/skupinu. Tohle je metoda,
     * kterou by mělo používat všechno NOVÉ volající místo (rotující
     * mód, FB volání) — sjednocuje "SIP jméno" a "číslo, co se pošle
     * jako Twilio from" do jedné konzistentní dvojice, aby nemohlo
     * dojít k nesourodému spárování (např. SIP jméno linky 3 + CLIP
     * linky 5).
     *
     * Pro 'mobilni'/'pevna': sestaví identity ze stávajících
     * getActiveSipNames()/getPhoneNumberForLine() — VŠECHNY identity
     * ve skupině dostanou STEJNÉ fromNumber (odpovídá dnešní realitě,
     * kde hejda_test1 i hejda_test2 obě ukazují 703614594).
     *
     * Pro 'fb': čte NOVĚ párované ODORIK_FB_SIP_NAME_X /
     * ODORIK_FB_CLIP_X — každá identita má SVÉ VLASTNÍ fromNumber.
     * Pokud pro některý index chybí ODORIK_FB_CLIP_X (nastavené jen
     * SIP jméno, ne CLIP, nebo naopak), ten index se PŘESKOČÍ a
     * vypíše se warning — bezpečnější než vytvořit identitu s
     * prázdným/nesprávným číslem.
     */
    getIdentitiesForLine(line: OdorikLine = 'mobilni'): OdorikIdentity[] {
        if (line === 'fb') {
            const identities: OdorikIdentity[] = [];
            let i = 1;
            while (true) {
                const sipName = process.env[`ODORIK_FB_SIP_NAME_${i}`];
                const fromNumber = process.env[`ODORIK_FB_CLIP_${i}`];

                if (!sipName && !fromNumber) break; // konec sekvence

                if (!sipName || !fromNumber) {
                    console.warn(`⚠️ FB identita #${i} neúplná (sipName: ${sipName || 'CHYBÍ'}, fromNumber: ${fromNumber || 'CHYBÍ'}) — přeskakuji`);
                    i++;
                    continue;
                }

                identities.push({ sipName, fromNumber });
                i++;
            }
            return identities;
        }

        // mobilni / pevna — zpětně kompatibilní sestavení ze
        // stávajících metod, žádná změna jejich chování.
        const sipNames = this.getActiveSipNames(line);
        const sharedFromNumber = this.getPhoneNumberForLine(line);
        return sipNames.map(sipName => ({ sipName, fromNumber: sharedFromNumber }));
    }

    /**
     * Konvertuje český telefonní číslo do Odorik formátu s prefixem *087.
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
     * Získá aktuální seznam routes pro SIP jméno. Nezávisí na lince —
     * SIP jméno samo o sobě jednoznačně identifikuje cíl v Odorik API.
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
     * Smaže VŠECHNY existující routes na SIP jméně.
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
     *
     * ⚠️ response.data.errors se kontroluje explicitně — Odorik API
     * vrací chybu jako HTTP 200 s { errors: [...] } v těle, ne jako
     * chybový HTTP status.
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

            if (response.data && response.data.errors) {
                console.error(`❌ Odorik setForward vrátilo chybu (HTTP 200, ale s errors):`, response.data.errors);

                await createAlertThrottled({
                    type: 'ODORIK_API_ERROR',
                    message: `Odorik API vrátilo chybu při setForward pro ${sipName}: ${JSON.stringify(response.data.errors)}`,
                    severity: 'error',
                    metadata: { sipName, targetPhone, errors: response.data.errors },
                });

                throw new Error(`Odorik setForward error: ${JSON.stringify(response.data.errors)}`);
            }

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