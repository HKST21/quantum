import React, { useEffect, useState, useCallback } from 'react';
import { getActiveBatchJob, batchJobLogUrl, ActiveBatchJobInfo, BatchJobInfo } from '../api';
import { useAuth } from '../context/AuthContext';

// ============================================
// Živý přehled dávky na ústředně + stažení podrobného logu (jen ADMIN).
// Data: batch_jobs + batch_job_logs (zapisuje worker na ústředně), log se uchovává 3 dny.
// Zobrazuje se na stránce AI Volání nezávisle na tom, kdo dávku spustil
// (funguje i po obnovení stránky nebo z jiného zařízení).
// ============================================

const POLL_MS = 4000;
const LOG_WARN_SEC = 90;   // dlouho bez nového výpisu → žlutě
const LOG_ALERT_SEC = 180; // ještě déle → červeně (worker pravděpodobně neběží)

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
    pending: { text: 'Čeká na převzetí', cls: 'badge-warning' },
    running: { text: 'Běží', cls: 'badge-success' },
    completed: { text: 'Dokončeno', cls: 'badge-gray' },
    stopped: { text: 'Zastaveno', cls: 'badge-warning' },
    failed: { text: 'Selhalo', cls: 'badge-danger' },
};

const fmtTime = (iso: string | null): string => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const fmtAge = (sec: number | null): string => {
    if (sec === null || sec === undefined) return '—';
    if (sec < 60) return `${sec} s`;
    const m = Math.floor(sec / 60);
    return m < 60 ? `${m} min ${sec % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

const fmtSize = (bytes: number): string =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;

const DownloadButton: React.FC<{ job: BatchJobInfo; label?: string }> = ({ job, label }) =>
    job.hasLog ? (
        <a className="btn btn-outline btn-sm" href={batchJobLogUrl(job.id)} download>
            ⬇ {label ?? 'Stáhnout log'} <span className="td-muted">({fmtSize(job.logBytes)})</span>
        </a>
    ) : (
        <span className="td-muted" style={{ fontSize: 12 }}>log není (vypršel nebo se neukládal)</span>
    );

const BatchJobPanel: React.FC = () => {
    // Tvar AuthContextu nepřebíráme natvrdo — stačí vědět, jestli je přihlášený ADMIN.
    const auth = useAuth() as unknown as { user?: { role?: string } | null };
    const isAdmin = auth?.user?.role === 'ADMIN';

    const [active, setActive] = useState<ActiveBatchJobInfo | null>(null);
    const [recent, setRecent] = useState<BatchJobInfo[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState('');
    const [showTail, setShowTail] = useState(true);
    const [showRecent, setShowRecent] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await getActiveBatchJob();
            setActive(res.active);
            setRecent(res.recent);
            setError('');
        } catch (e) {
            setError((e as Error).message || 'Nepodařilo se načíst stav ústředny');
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        if (!isAdmin) return;
        void load();
        const timer = setInterval(() => {
            if (!document.hidden) void load();
        }, POLL_MS);
        const onVisible = () => { if (!document.hidden) void load(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [isAdmin, load]);

    if (!isAdmin) return null;

    const progress = active && active.queuedLeads && active.queuedLeads > 0
        ? Math.min(100, Math.round((active.processedLeads / active.queuedLeads) * 100))
        : 0;

    const logAge = active?.lastLogAgeSec ?? null;
    const silent = active?.status === 'running' && logAge !== null && logAge >= LOG_ALERT_SEC;
    const slow = active?.status === 'running' && logAge !== null && logAge >= LOG_WARN_SEC && !silent;

    return (
        <div className="card mb-16" style={{ maxWidth: 760 }}>
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="card-title">🛰 Ústředna — živý stav dávky</span>
                {loaded && !error && <span className="td-muted" style={{ fontSize: 11 }}>aktualizace každé 4 s</span>}
            </div>
            <div className="card-body">
                {error && <div className="alert alert-danger mb-8">⚠️ {error}</div>}

                {!loaded && !error && <div className="td-muted">Načítám…</div>}

                {loaded && !active && !error && (
                    <div style={{ fontSize: 14 }}>
                        💤 Na ústředně právě neběží žádná dávka.
                    </div>
                )}

                {active && (
                    <div>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                            <span className="live-dot" />
                            <span className={`badge ${STATUS_LABEL[active.status]?.cls ?? 'badge-gray'}`}>
                                {STATUS_LABEL[active.status]?.text ?? active.status}
                            </span>
                            <strong>{active.agentName}</strong>
                            <span className="td-muted" style={{ fontSize: 12 }}>
                                spuštěno {fmtTime(active.startedAt ?? active.createdAt)}
                                {active.stopRequested ? ' · 🛑 stop požadován, doběhne rozběhnutý hovor' : ''}
                            </span>
                        </div>

                        {active.status === 'pending' && (
                            <div className="alert alert-warning mb-8">
                                ⏳ Úkol čeká, až ho převezme ústředna (obvykle do několika sekund).
                                Pokud to trvá déle než minutu, služba na ústředně pravděpodobně neběží.
                            </div>
                        )}

                        {active.status === 'running' && (
                            <>
                                <div className="flex justify-between items-center mb-8">
                                    <span style={{ fontSize: 13 }}>
                                        Zpracováno <strong>{active.processedLeads}</strong> z <strong>{active.queuedLeads ?? '?'}</strong> leadů
                                    </span>
                                    <span style={{ fontSize: 12, color: 'var(--gray-500)' }}>{progress}%</span>
                                </div>
                                <div className="progress-wrapper mb-8"><div className="progress-bar" style={{ width: `${progress}%` }} /></div>

                                <div style={{
                                    fontSize: 12, marginBottom: 10, fontWeight: 600,
                                    color: silent ? '#dc2626' : slow ? '#d97706' : '#16a34a',
                                }}>
                                    {silent
                                        ? `⚠️ Poslední výpis ústředny před ${fmtAge(logAge)} — worker pravděpodobně neběží nebo se zasekl`
                                        : slow
                                            ? `⏳ Poslední výpis před ${fmtAge(logAge)} (hovor může být dlouhý)`
                                            : logAge !== null
                                                ? `✅ Ústředna žije — poslední výpis před ${fmtAge(logAge)}`
                                                : '⏳ Zatím žádný výpis (úkol se právě rozbíhá)'}
                                </div>
                            </>
                        )}

                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                            <DownloadButton job={active} label="Stáhnout aktuální log" />
                            {active.tail.length > 0 && (
                                <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowTail(!showTail)}>
                                    {showTail ? 'Skrýt poslední řádky' : 'Zobrazit poslední řádky'}
                                </button>
                            )}
                        </div>

                        {showTail && active.tail.length > 0 && (
                            <pre style={{
                                background: '#0f172a', color: '#e2e8f0', borderRadius: 8, padding: '10px 12px',
                                fontSize: 11, lineHeight: 1.5, maxHeight: 260, overflow: 'auto', margin: 0,
                                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            }}>
                                {active.tail.join('\n')}
                            </pre>
                        )}
                    </div>
                )}

                {loaded && recent.length > 0 && (
                    <div style={{ marginTop: active ? 16 : 12, borderTop: active ? '1px solid var(--gray-200)' : 'none', paddingTop: active ? 12 : 0 }}>
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowRecent(!showRecent)}>
                            {showRecent ? '▲ Skrýt' : '▼ Zobrazit'} poslední dávky a jejich logy (3 dny)
                        </button>
                        {showRecent && (
                            <table style={{ marginTop: 10, width: '100%' }}>
                                <thead>
                                <tr>
                                    <th>Spuštěno</th>
                                    <th>Agent</th>
                                    <th>Stav</th>
                                    <th>Leady</th>
                                    <th>Log</th>
                                </tr>
                                </thead>
                                <tbody>
                                {recent.map((j) => (
                                    <tr key={j.id}>
                                        <td className="td-muted" style={{ whiteSpace: 'nowrap' }}>{fmtTime(j.startedAt ?? j.createdAt)}</td>
                                        <td>{j.agentName}</td>
                                        <td>
                                            <span className={`badge ${STATUS_LABEL[j.status]?.cls ?? 'badge-gray'}`} title={j.errorMessage ?? undefined}>
                                                {STATUS_LABEL[j.status]?.text ?? j.status}
                                            </span>
                                        </td>
                                        <td className="td-muted">{j.processedLeads}/{j.queuedLeads ?? '?'}</td>
                                        <td><DownloadButton job={j} label="Stáhnout" /></td>
                                    </tr>
                                ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default BatchJobPanel;