import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getBatchResults, BatchResultLead } from '../api';
import * as XLSX from 'xlsx';

const BatchDetail: React.FC = () => {
    const { date } = useParams<{ date: string }>();
    const navigate = useNavigate();
    const [leads, setLeads] = useState<BatchResultLead[]>([]);
    const [loading, setLoading] = useState(true);
    const [playingUrl, setPlayingUrl] = useState<string | null>(null);

    useEffect(() => {
        const load = async () => {
            if (!date) return;
            try {
                const res = await getBatchResults(date);
                setLeads(res.leads);
            } catch (err) {
                console.error('Failed to load batch results:', err);
            } finally {
                setLoading(false);
            }
        };
        load();
    }, [date]);

    const formatDate = (dateStr: string): string => {
        const d = new Date(dateStr);
        return d.toLocaleDateString('cs-CZ', {
            weekday: 'long',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
        });
    };

    const formatDuration = (sec: number | null): string => {
        if (!sec) return '—';
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };

    const avgDuration = leads.length > 0
        ? Math.round(leads.reduce((acc, l) => acc + (l.delka_sec || 0), 0) / leads.length)
        : 0;

    const handleExport = () => {
        if (leads.length === 0) return;

        const rows = leads.map((l) => ({
            'Telefon': l.telefon,
            'Jméno': l.jmeno,
            'Firma': l.firma,
            'Délka (s)': l.delka_sec,
            'Poznámka Evy': l.poznamka_evy,
            'Nahrávka URL': l.nahravka,
            'Datum hovoru': l.datum_hovoru,
        }));

        const ws = XLSX.utils.json_to_sheet(rows);

        // Šířky sloupců
        ws['!cols'] = [
            { wch: 18 },  // Telefon
            { wch: 20 },  // Jméno
            { wch: 25 },  // Firma
            { wch: 10 },  // Délka
            { wch: 40 },  // Poznámka
            { wch: 60 },  // URL
            { wch: 18 },  // Datum
        ];

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Zájemci');
        XLSX.writeFile(wb, `quantum_zajemci_${date}.xlsx`);
    };

    return (
        <div>
            <div className="page-header">
                <div>
                    <button
                        className="btn btn-outline btn-sm mb-8"
                        onClick={() => navigate('/crm/history')}
                    >
                        ← Zpět na historii
                    </button>
                    <h1 className="page-title">
                        Dávka: {date ? formatDate(date) : '—'}
                    </h1>
                    <p className="page-subtitle">
                        {leads.length} zájemců (CHCE_KONTAKT_AI)
                    </p>
                </div>
                <button
                    className="btn btn-success btn-lg"
                    onClick={handleExport}
                    disabled={leads.length === 0}
                >
                    ⬇ Export XLSX
                </button>
            </div>

            {/* STATISTIKY */}
            {!loading && leads.length > 0 && (
                <div className="stats-grid mb-24">
                    <div className="stat-card">
                        <div className="stat-label">Zájemců</div>
                        <div className="stat-value success">{leads.length}</div>
                        <div className="stat-sub">CHCE_KONTAKT_AI</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">S nahrávkou</div>
                        <div className="stat-value primary">
                            {leads.filter((l) => l.nahravka).length}
                        </div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Prům. délka</div>
                        <div className="stat-value">{formatDuration(avgDuration)}</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Nejdelší hovor</div>
                        <div className="stat-value">
                            {formatDuration(Math.max(...leads.map((l) => l.delka_sec || 0)))}
                        </div>
                    </div>
                </div>
            )}

            {/* TABULKA */}
            <div className="table-wrapper">
                {loading ? (
                    <div className="loading-spinner">
                        <span className="spinner" />
                        Načítám výsledky...
                    </div>
                ) : leads.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state-icon">📭</div>
                        <div className="empty-state-text">
                            Pro tento den nejsou žádní zájemci
                        </div>
                    </div>
                ) : (
                    <table>
                        <thead>
                        <tr>
                            <th>#</th>
                            <th>Telefon</th>
                            <th>Jméno / Firma</th>
                            <th>Délka</th>
                            <th>Nahrávka</th>
                            <th>Poznámka Evy</th>
                            <th>Datum hovoru</th>
                        </tr>
                        </thead>
                        <tbody>
                        {leads.map((lead, idx) => (
                            <tr key={`${lead.telefon}-${idx}`}>
                                <td className="td-muted" style={{ width: 40 }}>
                                    {idx + 1}
                                </td>
                                <td className="td-phone">{lead.telefon}</td>
                                <td>
                                    {lead.firma && (
                                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                                            {lead.firma}
                                        </div>
                                    )}
                                    {lead.jmeno && (
                                        <div className="td-muted">{lead.jmeno}</div>
                                    )}
                                    {!lead.firma && !lead.jmeno && (
                                        <span className="td-muted">—</span>
                                    )}
                                </td>
                                <td className="td-muted">
                                    {formatDuration(lead.delka_sec)}
                                </td>
                                <td>
                                    {lead.nahravka ? (
                                        <div className="audio-player">
                                            {playingUrl === lead.nahravka ? (
                                                <audio
                                                    src={lead.nahravka}
                                                    controls
                                                    autoPlay
                                                    style={{ width: 200, height: 28 }}
                                                    onEnded={() => setPlayingUrl(null)}
                                                />
                                            ) : (
                                                <button
                                                    className="btn btn-outline btn-sm"
                                                    onClick={() => setPlayingUrl(lead.nahravka)}
                                                >
                                                    ▶ Přehrát
                                                </button>
                                            )}
                                        </div>
                                    ) : (
                                        <span className="td-muted">—</span>
                                    )}
                                </td>
                                <td style={{ maxWidth: 260 }}>
                                    {lead.poznamka_evy ? (
                                        <span
                                            style={{
                                                fontSize: 12,
                                                color: 'var(--gray-600)',
                                                display: '-webkit-box',
                                                WebkitLineClamp: 2,
                                                WebkitBoxOrient: 'vertical',
                                                overflow: 'hidden',
                                            }}
                                            title={lead.poznamka_evy}
                                        >
                        {lead.poznamka_evy}
                      </span>
                                    ) : (
                                        <span className="td-muted">—</span>
                                    )}
                                </td>
                                <td className="td-muted" style={{ whiteSpace: 'nowrap' }}>
                                    {lead.datum_hovoru}
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

export default BatchDetail;