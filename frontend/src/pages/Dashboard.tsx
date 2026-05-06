import React, { useState, useEffect, useCallback } from 'react';
import { getLeads, getUsers, blacklistLead, Lead, User } from '../api';

const AI_AGENT_ID = '53c65ca7-68bc-4948-83e5-35a64c17f0fb';
const PAGE_SIZE = 500;

const STATUS_LABELS: Record<string, { label: string; badge: string }> = {
    NOVY: { label: 'Nový', badge: 'badge-primary' },
    CHCE_KONTAKT_AI: { label: 'Chce kontakt', badge: 'badge-success' },
    NEZVEDL_TELEFON: { label: 'Nezvedl', badge: 'badge-warning' },
    ODMITNUTO: { label: 'Odmítnuto', badge: 'badge-danger' },
    NEKONTAKTOVAT: { label: 'Nekontaktovat', badge: 'badge-danger' },
    ODKLADA: { label: 'Odkládá', badge: 'badge-warning' },
    CHCE_NABIDKU: { label: 'Chce nabídku', badge: 'badge-success' },
    POSLAL_FAKTURU: { label: 'Poslal fakturu', badge: 'badge-primary' },
    NABIDKA_PREDLOZENA: { label: 'Nabídka předložena', badge: 'badge-primary' },
    CHCE_PODEPSAT_SMLOUVU: { label: 'Chce podepsat', badge: 'badge-success' },
    UZAVRENO: { label: 'Uzavřeno', badge: 'badge-success' },
    NEDOSTUPNY: { label: 'Nedostupný', badge: 'badge-gray' },
};

const ALL_STATUSES = Object.keys(STATUS_LABELS);

const Dashboard: React.FC = () => {
    const [leads, setLeads] = useState<Lead[]>([]);
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);

    // Filtry
    const [filterStatus, setFilterStatus] = useState('');
    const [filterAssignedTo, setFilterAssignedTo] = useState(AI_AGENT_ID);
    const [filterSearch, setFilterSearch] = useState('');
    const [searchInput, setSearchInput] = useState('');

    // Blacklist
    const [blacklistingId, setBlacklistingId] = useState<string | null>(null);
    const [blacklistConfirm, setBlacklistConfirm] = useState<string | null>(null);

    // Audio
    const [playingUrl, setPlayingUrl] = useState<string | null>(null);

    const fetchLeads = useCallback(async () => {
        setLoading(true);
        try {
            const res = await getLeads({
                status: filterStatus || undefined,
                assignedTo: filterAssignedTo || undefined,
                search: filterSearch || undefined,
                page,
                limit: PAGE_SIZE,
            });
            setLeads(res.data);
            setTotal(res.pagination.total);
            setTotalPages(res.pagination.totalPages);
        } catch (err) {
            console.error('Failed to fetch leads:', err);
        } finally {
            setLoading(false);
        }
    }, [filterStatus, filterAssignedTo, filterSearch, page]);

    const fetchUsers = useCallback(async () => {
        try {
            const res = await getUsers();
            setUsers(res.users);
        } catch (err) {
            console.error('Failed to fetch users:', err);
        }
    }, []);

    useEffect(() => {
        fetchUsers();
    }, [fetchUsers]);

    useEffect(() => {
        setPage(1);
    }, [filterStatus, filterAssignedTo, filterSearch]);

    useEffect(() => {
        fetchLeads();
    }, [fetchLeads]);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        setFilterSearch(searchInput);
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

    const formatDuration = (sec: number | null) => {
        if (!sec) return '—';
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };

    const renderPageNumbers = () => {
        const pages: number[] = [];
        const delta = 2;
        for (let i = Math.max(1, page - delta); i <= Math.min(totalPages, page + delta); i++) {
            pages.push(i);
        }
        return pages;
    };

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Dashboard</h1>
                    <p className="page-subtitle">
                        Celkem {total.toLocaleString('cs-CZ')} leadů
                        {filterAssignedTo === AI_AGENT_ID ? ' · Eva AI Agent' : ''}
                    </p>
                </div>
                <button className="btn btn-outline btn-sm" onClick={fetchLeads}>
                    ↻ Obnovit
                </button>
            </div>

            {/* FILTRY */}
            <div className="card mb-16">
                <div className="card-body" style={{ padding: '14px 20px' }}>
                    <form onSubmit={handleSearch} className="filters-bar">
                        <input
                            type="text"
                            className="form-input search-input"
                            placeholder="🔍 Hledat telefon, firma, kontakt..."
                            value={searchInput}
                            onChange={(e) => setSearchInput(e.target.value)}
                        />

                        <select
                            className="form-select"
                            value={filterStatus}
                            onChange={(e) => setFilterStatus(e.target.value)}
                        >
                            <option value="">Všechny statusy</option>
                            {ALL_STATUSES.map((s) => (
                                <option key={s} value={s}>
                                    {STATUS_LABELS[s]?.label || s}
                                </option>
                            ))}
                        </select>

                        <select
                            className="form-select"
                            value={filterAssignedTo}
                            onChange={(e) => setFilterAssignedTo(e.target.value)}
                        >
                            <option value="">Všichni agenti</option>
                            {users.map((u) => (
                                <option key={u.id} value={u.id}>
                                    {u.fullName}
                                </option>
                            ))}
                        </select>

                        <button type="submit" className="btn btn-primary">
                            Hledat
                        </button>

                        {(filterStatus || filterSearch || filterAssignedTo !== AI_AGENT_ID) && (
                            <button
                                type="button"
                                className="btn btn-outline"
                                onClick={() => {
                                    setFilterStatus('');
                                    setFilterSearch('');
                                    setSearchInput('');
                                    setFilterAssignedTo(AI_AGENT_ID);
                                }}
                            >
                                ✕ Reset
                            </button>
                        )}
                    </form>
                </div>
            </div>

            {/* TABULKA */}
            <div className="table-wrapper">
                {loading ? (
                    <div className="loading-spinner">
                        <span className="spinner" />
                        Načítám leady...
                    </div>
                ) : leads.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state-icon">📭</div>
                        <div className="empty-state-text">Žádné leady nenalezeny</div>
                    </div>
                ) : (
                    <table>
                        <thead>
                        <tr>
                            <th>Telefon</th>
                            <th>Firma / Kontakt</th>
                            <th>Status</th>
                            <th>Přiřazen</th>
                            <th>Nahrávka</th>
                            <th>Délka</th>
                            <th>Poznámka Evy</th>
                            <th>Datum</th>
                            <th>Akce</th>
                        </tr>
                        </thead>
                        <tbody>
                        {leads.map((lead) => {
                            const aiLog = (lead as any).aiCallLogs?.[0];
                            const isBlacklisting = blacklistingId === lead.id;
                            const isConfirming = blacklistConfirm === lead.id;

                            return (
                                <tr key={lead.id}>
                                    <td className="td-phone">{lead.phone}</td>
                                    <td>
                                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                                            {lead.companyName || '—'}
                                        </div>
                                        {lead.contactPerson && (
                                            <div className="td-muted">{lead.contactPerson}</div>
                                        )}
                                    </td>
                                    <td>
                      <span className={`badge ${STATUS_LABELS[lead.status]?.badge || 'badge-gray'}`}>
                        {STATUS_LABELS[lead.status]?.label || lead.status}
                      </span>
                                    </td>
                                    <td className="td-muted">
                                        {lead.assignedTo?.fullName || '—'}
                                    </td>
                                    <td>
                                        {aiLog?.recordingUrl ? (
                                            <div className="audio-player">
                                                {playingUrl === aiLog.recordingUrl ? (
                                                    <audio
                                                        src={aiLog.recordingUrl}
                                                        controls
                                                        autoPlay
                                                        style={{ width: 200, height: 28 }}
                                                        onEnded={() => setPlayingUrl(null)}
                                                    />
                                                ) : (
                                                    <button
                                                        className="btn btn-outline btn-sm"
                                                        onClick={() => setPlayingUrl(aiLog.recordingUrl)}
                                                    >
                                                        ▶ Přehrát
                                                    </button>
                                                )}
                                            </div>
                                        ) : (
                                            <span className="td-muted">—</span>
                                        )}
                                    </td>
                                    <td className="td-muted">
                                        {formatDuration(aiLog?.duration)}
                                    </td>
                                    <td style={{ maxWidth: 220 }}>
                                        {aiLog?.aiNotes ? (
                                            <span
                                                style={{
                                                    fontSize: 12,
                                                    color: 'var(--gray-600)',
                                                    display: '-webkit-box',
                                                    WebkitLineClamp: 2,
                                                    WebkitBoxOrient: 'vertical',
                                                    overflow: 'hidden',
                                                }}
                                                title={aiLog.aiNotes}
                                            >
                          {aiLog.aiNotes}
                        </span>
                                        ) : (
                                            <span className="td-muted">—</span>
                                        )}
                                    </td>
                                    <td className="td-muted" style={{ whiteSpace: 'nowrap' }}>
                                        {new Date(lead.updatedAt).toLocaleDateString('cs-CZ', {
                                            day: '2-digit',
                                            month: '2-digit',
                                            year: '2-digit',
                                            hour: '2-digit',
                                            minute: '2-digit',
                                        })}
                                    </td>
                                    <td>
                                        {lead.status !== 'NEKONTAKTOVAT' && (
                                            <button
                                                className={`btn btn-sm ${isConfirming ? 'btn-danger' : 'btn-outline'}`}
                                                onClick={() => handleBlacklist(lead.id)}
                                                disabled={isBlacklisting}
                                                title={isConfirming ? 'Klikni znovu pro potvrzení' : 'Přidat na blacklist'}
                                            >
                                                {isBlacklisting ? '...' : isConfirming ? '⚠️ Potvrdit?' : '🚫'}
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                        </tbody>
                    </table>
                )}

                {/* PAGINACE */}
                {!loading && totalPages > 1 && (
                    <div className="pagination">
            <span className="pagination-info">
              Strana {page} z {totalPages} · {total.toLocaleString('cs-CZ')} leadů
            </span>
                        <div className="pagination-controls">
                            <button
                                className="pagination-btn"
                                onClick={() => setPage(1)}
                                disabled={page === 1}
                            >
                                «
                            </button>
                            <button
                                className="pagination-btn"
                                onClick={() => setPage((p) => p - 1)}
                                disabled={page === 1}
                            >
                                ‹
                            </button>
                            {renderPageNumbers().map((p) => (
                                <button
                                    key={p}
                                    className={`pagination-btn ${p === page ? 'active' : ''}`}
                                    onClick={() => setPage(p)}
                                >
                                    {p}
                                </button>
                            ))}
                            <button
                                className="pagination-btn"
                                onClick={() => setPage((p) => p + 1)}
                                disabled={page === totalPages}
                            >
                                ›
                            </button>
                            <button
                                className="pagination-btn"
                                onClick={() => setPage(totalPages)}
                                disabled={page === totalPages}
                            >
                                »
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default Dashboard;