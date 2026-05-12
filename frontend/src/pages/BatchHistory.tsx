import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBatchHistory, BatchHistoryItem } from '../api';

const AGENT_COLORS: Record<string, string> = {
    '53c65ca7-68bc-4948-83e5-35a64c17f0fb': '#2563eb', // Eva V1 - modrá
    'aeec78ff-a86b-4cab-b33a-adeb7c94f08e': '#7c3aed', // Eva V2 - fialová
    'e7a469bb-4783-4f96-b961-03dd503e5bfa': '#059669', // Eva V3 - zelená
    'f4adb349-70c3-4e63-8670-81f6c177f61d': '#d97706', // Eva V4 - oranžová
};

const BatchHistory: React.FC = () => {
    const [batches, setBatches] = useState<BatchHistoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const navigate = useNavigate();

    useEffect(() => {
        const load = async () => {
            try {
                const res = await getBatchHistory();
                setBatches(res.batches);
            } catch (err) {
                console.error('Failed to load batch history:', err);
            } finally {
                setLoading(false);
            }
        };
        load();
    }, []);

    const formatDuration = (sec: number): string => {
        if (!sec) return '—';
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };

    const formatDate = (dateStr: string): string => {
        const d = new Date(dateStr);
        return d.toLocaleDateString('cs-CZ', {
            weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
        });
    };

    const getConversionStyle = (rate: number): React.CSSProperties => {
        if (rate >= 6) return { background: '#14532d', color: '#fff' };
        if (rate >= 5) return { background: '#16a34a', color: '#fff' };
        if (rate >= 4) return { background: '#4ade80', color: '#14532d' };
        if (rate >= 3) return { background: '#f59e0b', color: '#fff' };
        return { background: '#dc2626', color: '#fff' };
    };

    const getConversionLabel = (rate: number): string => {
        if (rate >= 6) return '🔥';
        if (rate >= 5) return '✅';
        if (rate >= 4) return '👍';
        if (rate >= 3) return '⚠️';
        return '❌';
    };

    // Celkové součty
    const totals = batches.reduce(
        (acc, b) => ({
            celkemHovoru: acc.celkemHovoru + b.celkemHovoru,
            interested: acc.interested + b.interested,
            noAnswer: acc.noAnswer + b.noAnswer,
            rejected: acc.rejected + b.rejected,
            callback: acc.callback + b.callback,
        }),
        { celkemHovoru: 0, interested: 0, noAnswer: 0, rejected: 0, callback: 0 }
    );

    const totalConversion = totals.celkemHovoru > 0
        ? Math.round((totals.interested / totals.celkemHovoru) * 100)
        : 0;

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Historie dávek</h1>
                    <p className="page-subtitle">Posledních 30 dní · {batches.length} dávek · všichni agenti</p>
                </div>
            </div>

            {/* SOUHRN */}
            {!loading && batches.length > 0 && (
                <div className="stats-grid mb-24">
                    <div className="stat-card">
                        <div className="stat-label">Celkem dávek</div>
                        <div className="stat-value primary">{batches.length}</div>
                        <div className="stat-sub">za 30 dní</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Celkem hovorů</div>
                        <div className="stat-value primary">{totals.celkemHovoru.toLocaleString('cs-CZ')}</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Celkem zájem</div>
                        <div className="stat-value success">{totals.interested.toLocaleString('cs-CZ')}</div>
                        <div className="stat-sub">CHCE_KONTAKT_AI</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Prům. konverze</div>
                        <div style={{ marginTop: 6 }}>
              <span style={{
                  ...getConversionStyle(totalConversion),
                  padding: '4px 12px', borderRadius: 20, fontWeight: 700, fontSize: 22,
              }}>
                {totalConversion}% {getConversionLabel(totalConversion)}
              </span>
                        </div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Nezvedlo</div>
                        <div className="stat-value warning">{totals.noAnswer.toLocaleString('cs-CZ')}</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Odmítnuto</div>
                        <div className="stat-value danger">{totals.rejected.toLocaleString('cs-CZ')}</div>
                    </div>
                </div>
            )}

            {/* LEGENDA konverze */}
            {!loading && batches.length > 0 && (
                <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--gray-500)', marginRight: 4 }}>Konverze:</span>
                    {[
                        { label: '≥6% 🔥', rate: 6 },
                        { label: '≥5% ✅', rate: 5 },
                        { label: '≥4% 👍', rate: 4 },
                        { label: '≥3% ⚠️', rate: 3 },
                        { label: '<3% ❌', rate: 2 },
                    ].map((item) => (
                        <span key={item.label} style={{
                            ...getConversionStyle(item.rate),
                            padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                        }}>
              {item.label}
            </span>
                    ))}
                </div>
            )}

            {/* TABULKA */}
            <div className="table-wrapper">
                {loading ? (
                    <div className="loading-spinner"><span className="spinner" />Načítám historii...</div>
                ) : batches.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state-icon">📭</div>
                        <div className="empty-state-text">Zatím žádné dávky</div>
                    </div>
                ) : (
                    <table>
                        <thead>
                        <tr>
                            <th>Datum</th>
                            <th>Agent</th>
                            <th>Celkem hovorů</th>
                            <th>Zájem ✅</th>
                            <th>Nezvedl</th>
                            <th>Odmítnuto</th>
                            <th>Odkládá</th>
                            <th>Konverze</th>
                            <th>Prům. délka</th>
                            <th>Detail</th>
                        </tr>
                        </thead>
                        <tbody>
                        {batches.map((batch, idx) => (
                            <tr
                                key={`${batch.datum}-${(batch as any).agentId}-${idx}`}
                                style={{ cursor: 'pointer' }}
                                onClick={() => navigate(`/crm/history/${batch.datum}?agentUserId=${(batch as any).agentId}`)}
                            >
                                <td style={{ fontWeight: 600 }}>{formatDate(batch.datum)}</td>
                                <td>
                    <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 10px',
                        borderRadius: 20,
                        fontSize: 12,
                        fontWeight: 600,
                        background: `${AGENT_COLORS[(batch as any).agentId] || '#6b7280'}18`,
                        color: AGENT_COLORS[(batch as any).agentId] || '#6b7280',
                        border: `1px solid ${AGENT_COLORS[(batch as any).agentId] || '#6b7280'}40`,
                    }}>
                      🤖 {(batch as any).agentName || 'Neznámý agent'}
                    </span>
                                </td>
                                <td style={{ fontWeight: 600 }}>{batch.celkemHovoru.toLocaleString('cs-CZ')}</td>
                                <td><span className="badge badge-success">{batch.interested}</span></td>
                                <td><span className="badge badge-warning">{batch.noAnswer}</span></td>
                                <td><span className="badge badge-danger">{batch.rejected}</span></td>
                                <td><span className="badge badge-gray">{batch.callback}</span></td>
                                <td>
                    <span style={{
                        ...getConversionStyle(batch.conversionRate),
                        padding: '3px 10px', borderRadius: 20, fontSize: 12,
                        fontWeight: 700, display: 'inline-block',
                    }}>
                      {batch.conversionRate}% {getConversionLabel(batch.conversionRate)}
                    </span>
                                </td>
                                <td className="td-muted">{formatDuration(batch.avgDuration)}</td>
                                <td>
                                    <button
                                        className="btn btn-outline btn-sm"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            navigate(`/crm/history/${batch.datum}?agentUserId=${(batch as any).agentId}`);
                                        }}
                                    >
                                        → Detail
                                    </button>
                                </td>
                            </tr>
                        ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
};

export default BatchHistory;