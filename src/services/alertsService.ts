import pool from '../db/pool';

// ============================================================================
// ALERTS SERVICE
// ============================================================================
//
// Helper pro vytváření alertů z různých částí aplikace.
// Alerty se ukládají do DB tabulky `alerts` a frontend je zobrazuje
// jako notification bell v Layoutu (polling každých 10s).
//
// Použití:
//   await createAlert({
//       type: 'ODORIK_API_ERROR',
//       message: 'Odorik API selhalo při deleteRoute',
//       severity: 'error',
//       metadata: { sipName: 'hejda_test1', error: err.message }
//   });
// ============================================================================

export type AlertSeverity = 'error' | 'warning' | 'info';

export interface CreateAlertParams {
    type: string;
    message: string;
    severity?: AlertSeverity;
    metadata?: Record<string, any>;
}

/**
 * Vytvoří nový alert v DB. Volá se z různých error handlerů v aplikaci.
 * Selhání této funkce nesmí shodit hlavní flow (proto vždy try/catch).
 */
export const createAlert = async (params: CreateAlertParams): Promise<void> => {
    const { type, message, severity = 'error', metadata = {} } = params;

    try {
        await pool.query(
            `INSERT INTO alerts (type, message, severity, metadata)
             VALUES ($1, $2, $3, $4)`,
            [type, message, severity, JSON.stringify(metadata)]
        );

        console.log(`🔔 Alert created: [${severity}] ${type}: ${message}`);
    } catch (error) {
        // NIKDY nesmí shodit hlavní flow
        console.error('⚠️ Failed to create alert (non-critical):', error);
    }
};

/**
 * Rate limiting - vytvoří alert jen pokud za posledních X minut nebyl
 * podobný alert stejného typu. Zabrání spammování notification bellu.
 */
export const createAlertThrottled = async (
    params: CreateAlertParams & { throttleMinutes?: number }
): Promise<void> => {
    const { throttleMinutes = 5, ...alertParams } = params;

    try {
        // Zkontroluj kolik alertů stejného typu bylo za posledních X minut
        const check = await pool.query(
            `SELECT COUNT(*) as count 
             FROM alerts 
             WHERE type = $1 
               AND created_at > NOW() - INTERVAL '${throttleMinutes} minutes'
               AND resolved = false`,
            [alertParams.type]
        );

        const recentCount = parseInt(check.rows[0].count, 10);

        if (recentCount > 0) {
            console.log(`🔕 Alert throttled: ${alertParams.type} (${recentCount} recent unresolved)`);
            return;
        }

        await createAlert(alertParams);
    } catch (error) {
        console.error('⚠️ Failed to check throttled alert (non-critical):', error);
    }
};