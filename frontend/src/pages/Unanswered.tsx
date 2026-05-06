import React, { useState, useEffect, useCallback } from 'react';
import { getUnanswered, retryUnanswered, blacklistLead, UnansweredLead } from '../api';

const Unanswered: React.FC = () => {
    const [leads, setLeads] = useState<UnansweredLead[]>([]);
    const [loading, setLoading] = useState(true);
    const [retrying, setRetrying] = useState(false);
    const [retryResult, setRetryResult] = useState<string | null>(null);
    const [blacklistingId, setBlacklistingId] = useState<string | null>(null);
    const [blacklistConfirm, setBlacklistConfirm] = useState<string | null>(null);
    const [error, setError] = useState('');

    const fetchLeads = useCallback(async () => {
        setLoading(true);
        setRetryResult(null);
        try {
            const res = await getUnanswered();
            setLeads(res.leads);
        } catch (err) {
            console.error('Failed to load unanswered:', err);
            setError('Nepodařilo se načíst nedovolané leady');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchLeads();
    }, [fetchLeads]);

    const handleRetryAll = async () => {
        if (leads.length === 0) return;
        setRetrying(true);
        setError('');
        try {
            const res = await retryUnanswered();
            setRetryResult(res.message);
            await fetchLeads();
        } catch (err: any) {
            setError(err.message || 'Chyba při zařazení do fronty');
        } finally {
            setRetrying(false);
        }
    };

    const handleBlacklist = async (id: string) => {
        if (blacklistConfirm !== id) {
            setBlacklistConfirm(id);
            return;
        }
        setBlacklistingId(id);
        setBlacklistConfirm(null);
        try {
            await blacklistLead(id);
            await fetchLeads();
        } catch (err) {
            console.error('Blacklist failed:', err);
        } finally {
            setBlacklistingId(null);
        }
    };

    const getAttemptsColor = (attempts: number): string => {
        if (attempts === 0) return 'var(--gray-400)';
        if (attempts === 1) return 'var(--warning)';
        return 'var(--danger)';
    };

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Nedovolané leady</h1>
                    <p className="page-subtitle">
                        Reálně nedovolané — bez nahrávky, max 2 pokusy z 3
                    </p>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                    <button
                        className="btn btn-outline btn-sm"
                        onClick={fetchLeads}
                        disabled={loading}
                    >
                        ↻ Obnovit
                    </button>
                    <button
                        className="btn btn-primary"
                        onClick={handleRetryAll}
                        disabled={retrying || leads.length === 0 || loading}
                    >
                        {retrying ? (
                            <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Zařazuji...</>
                        ) : (
                            `🔁 Znovu provolat vše (${leads.length})`
                        )}
                    </button>
                </div>
            </div>

            {/* INFO */}
            <div className="alert alert-info mb-16">
                <div>
                    <strong>Jak to funguje:</strong> Tato stránka zobrazuje pouze leady které{' '}
                    <strong>reálně nezvedly telefon</strong> — tzn. nemají žádnou nahrávku v{' '}
                    <code>ai_call_logs</code> a mají méně než 3 celkové pokusy.
                    Tlačítko "Znovu provolat" změní jejich status zpět na{' '}
                    <strong>NOVY</strong> a zařadí je do fronty pro AI agenta Evu.
                </div>
            </div>

            {error && (
                <div className="alert alert-danger mb-16">⚠️ {error}</div>
            )}

            {retryResult && (
                <div className="alert alert-success mb-16">
                    ✅ {retryResult}
                </div>
            )}

            {/* STATS */}
            {!loading && (
                <div className="stats-grid mb-16">
                    <div className="stat-card">
                        <div className="stat-label">Nedovolaných</div>
                        <div className="stat-value primary">{leads.length}</div>
                        <div className="stat-sub">eligible pro retry</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">1 pokus</div>
                        <div className="stat-value warning">
                            {leads.filter(l => l.totalAttempts === 1).length}
                        </div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">2 pokusy</div>
                        <div className="stat-value danger">
                            {leads.filter(l => l.totalAttempts === 2).length}
                        </div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Ochrana</div>
                        <div className="stat-value" style={{ fontSize: 14, color: 'var(--gray-500)' }}>
                            max 3×
                        </div>
                        <div className="stat-sub">přes ai_call_logs</div>
                    </div>
                </div>
            )}

            {/* TABULKA */}
            <div className="table-wrapper">
                {loading ? (
                    <div className="loading-spinner">
                        <span className="spinner" />
                        Načítám nedovolané...
                    </div>
                ) : leads.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state-icon">🎉</div>
                        <div className="empty-state-text">
                            Žádné nedovolané leady k opakování
                        </div>
                    </div>
                ) : (
                    <table>
                        <thead>
                        <tr>
                            <th>Telefon</th>
                            <th>Firma</th>
                            <th>Pokusy celkem</th>
                            <th>S nahrávkou</th>
                            <th>Status</th>
                            <th>Akce</th>
                        </tr>
                        </thead>
                        <tbody>
                        {leads.map((lead) => {
                            const isBlacklisting = blacklistingId === lead.id;
                            const isConfirming = blacklistConfirm === lead.id;

                            return (
                                <tr key={lead.id}>
                                    <td className="td-phone">{lead.phone}</td>
                                    <td>
                                        {lead.companyName || <span className="td-muted">—</span>}
                                    </td>
                                    <td>
                      <span style={{
                          fontWeight: 700,
                          color: getAttemptsColor(lead.totalAttempts),
                      }}>
                        {lead.totalAttempts}×
                      </span>
                                        <span className="td-muted" style={{ marginLeft: 4, fontSize: 11 }}>
                        z max 3
                      </span>
                                    </td>
                                    <td>
                      <span className="badge badge-gray">
                        {lead.attemptsWithRecording}
                      </span>
                                    </td>
                                    <td>
                      <span className="badge badge-warning">
                        NEZVEDL
                      </span>
                                    </td>
                                    <td>
                                        <div style={{ display: 'flex', gap: 6 }}>
                                            <button
                                                className={`btn btn-sm ${isConfirming ? 'btn-danger' : 'btn-outline'}`}
                                                onClick={() => handleBlacklist(lead.id)}
                                                disabled={isBlacklisting}
                                                title={isConfirming ? 'Klikni znovu pro potvrzení' : 'Přidat na blacklist'}
                                            >
                                                {isBlacklisting ? '...' : isConfirming ? '⚠️ Potvrdit?' : '🚫'}
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
};

export default Unanswered;