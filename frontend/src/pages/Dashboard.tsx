import React, { useState, useEffect, useCallback } from 'react';
import { getLeads, getUsers, blacklistLead, reassignLeads, deleteLeads, Lead, User } from '../api';

const AI_AGENT_ID = '53c65ca7-68bc-4948-83e5-35a64c17f0fb';
const PAGE_SIZE = 500;

const AGENTS = [
    { id: '53c65ca7-68bc-4948-83e5-35a64c17f0fb', name: 'Eva V1', description: 'VIP ceník do SMS' },
    { id: 'aeec78ff-a86b-4cab-b33a-adeb7c94f08e', name: 'Eva V2', description: 'Šetříme klientům až 40%' },
    { id: 'e7a469bb-4783-4f96-b961-03dd503e5bfa', name: 'Eva V3', description: 'Nepřeplácíte za služby?' },
    { id: 'f4adb349-70c3-4e63-8670-81f6c177f61d', name: 'Eva V4', description: 'Nezávazné porovnání' },
    { id: 'ffbabfc8-08e0-4dae-8a02-f9d7865f2bd9', name: 'Eva V5', description: 'Dvoustupňová kvalifikace' },
];

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
    const [filterStatus, setFilterStatus] = useState('NOVY');
    const [filterAssignedTo, setFilterAssignedTo] = useState(AI_AGENT_ID);
    const [filterSearch, setFilterSearch] = useState('');
    const [searchInput, setSearchInput] = useState('');

    // Blacklist
    const [blacklistingId, setBlacklistingId] = useState<string | null>(null);
    const [blacklistConfirm, setBlacklistConfirm] = useState<string | null>(null);

    // Audio
    const [playingUrl, setPlayingUrl] = useState<string | null>(null);

    // Panel přeřazení
    const [showReassign, setShowReassign] = useState(false);
    const [reassignFrom, setReassignFrom] = useState(AI_AGENT_ID);
    const [reassignTo, setReassignTo] = useState('aeec78ff-a86b-4cab-b33a-adeb7c94f08e');
    const [reassignCount, setReassignCount] = useState(100);
    const [reassigning, setReassigning] = useState(false);
    const [reassignResult, setReassignResult] = useState<string | null>(null);
    const [reassignError, setReassignError] = useState('');

    // Panel mazání
    const [showDelete, setShowDelete] = useState(false);
    const [deleteAgentId, setDeleteAgentId] = useState(AI_AGENT_ID);
    const [deleteCount, setDeleteCount] = useState(100);
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteResult, setDeleteResult] = useState<string | null>(null);
    const [deleteError, setDeleteError] = useState('');

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

    useEffect(() => { fetchUsers(); }, [fetchUsers]);
    useEffect(() => { setPage(1); }, [filterStatus, filterAssignedTo, filterSearch]);
    useEffect(() => { fetchLeads(); }, [fetchLeads]);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        setFilterSearch(searchInput);
    };

    const handleBlacklist = async (id: string) => {
        if (blacklistConfirm !== id) { setBlacklistConfirm(id); return; }
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

    const handleReassign = async () => {
        if (reassignFrom === reassignTo) {
            setReassignError('Zdrojový a cílový agent musí být různí');
            return;
        }
        setReassigning(true);
        setReassignResult(null);
        setReassignError('');
        try {
            const res = await reassignLeads(reassignFrom, reassignTo, reassignCount);
            setReassignResult(res.message);
            await fetchLeads();
        } catch (err: any) {
            setReassignError(err.message || 'Chyba při přeřazení');
        } finally {
            setReassigning(false);
        }
    };

    const handleDelete = async () => {
        if (!deleteConfirm) {
            setDeleteConfirm(true);
            return;
        }
        setDeleting(true);
        setDeleteResult(null);
        setDeleteError('');
        setDeleteConfirm(false);
        try {
            const res = await deleteLeads(deleteAgentId, deleteCount);
            setDeleteResult(res.message);
            await fetchLeads();
        } catch (err: any) {
            setDeleteError(err.message || 'Chyba při mazání');
        } finally {
            setDeleting(false);
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

    const getAgentName = (id: string) => AGENTS.find(a => a.id === id)?.name || id;

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Dashboard</h1>
                    <p className="page-subtitle">
                        Celkem {total.toLocaleString('cs-CZ')} leadů
                        {filterAssignedTo ? ` · ${getAgentName(filterAssignedTo)}` : ''}
                        {filterStatus ? ` · ${STATUS_LABELS[filterStatus]?.label || filterStatus}` : ''}
                    </p>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                    <button
                        className={`btn ${showReassign ? 'btn-primary' : 'btn-outline'} btn-sm`}
                        onClick={() => {
                            setShowReassign(!showReassign);
                            setShowDelete(false);
                            setReassignResult(null);
                            setReassignError('');
                        }}
                    >
                        🔀 Přeřadit leady
                    </button>
                    <button
                        className={`btn ${showDelete ? 'btn-danger' : 'btn-outline'} btn-sm`}
                        onClick={() => {
                            setShowDelete(!showDelete);
                            setShowReassign(false);
                            setDeleteResult(null);
                            setDeleteError('');
                            setDeleteConfirm(false);
                        }}
                    >
                        🗑 Smazat leady
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={fetchLeads}>
                        ↻ Obnovit
                    </button>
                </div>
            </div>

            {/* PANEL PŘEŘAZENÍ */}
            {showReassign && (
                <div className="card mb-16">
                    <div className="card-header">
                        <span className="card-title">🔀 Hromadné přeřazení leadů (NOVY)</span>
                        <span style={{ fontSize: 12, color: 'var(--gray-400)' }}>
              Přeřazuje od nejstarších (od spoda nahoru)
            </span>
                    </div>
                    <div className="card-body">
                        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                            <div className="form-group" style={{ margin: 0, minWidth: 200 }}>
                                <label className="form-label">Od agenta</label>
                                <select className="form-select" value={reassignFrom} onChange={(e) => setReassignFrom(e.target.value)}>
                                    {AGENTS.map(a => <option key={a.id} value={a.id}>{a.name} — {a.description}</option>)}
                                </select>
                            </div>
                            <div style={{ fontSize: 20, color: 'var(--gray-400)', paddingBottom: 4 }}>→</div>
                            <div className="form-group" style={{ margin: 0, minWidth: 200 }}>
                                <label className="form-label">K agentovi</label>
                                <select className="form-select" value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
                                    {AGENTS.map(a => <option key={a.id} value={a.id}>{a.name} — {a.description}</option>)}
                                </select>
                            </div>
                            <div className="form-group" style={{ margin: 0, minWidth: 120 }}>
                                <label className="form-label">Počet leadů</label>
                                <input
                                    type="number" className="form-input" min={1} max={10000}
                                    value={reassignCount}
                                    onChange={(e) => setReassignCount(Math.max(1, Number(e.target.value)))}
                                />
                            </div>
                            <button
                                className="btn btn-primary"
                                onClick={handleReassign}
                                disabled={reassigning || reassignFrom === reassignTo}
                                style={{ marginBottom: 1 }}
                            >
                                {reassigning ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Přeřazuji...</> : '🔀 Přeřadit'}
                            </button>
                        </div>
                        {reassignError && <div className="alert alert-danger mt-8">⚠️ {reassignError}</div>}
                        {reassignResult && <div className="alert alert-success mt-8">✅ {reassignResult}</div>}
                    </div>
                </div>
            )}

            {/* PANEL MAZÁNÍ */}
            {showDelete && (
                <div className="card mb-16" style={{ borderColor: 'var(--danger)' }}>
                    <div className="card-header" style={{ borderBottomColor: '#fecaca' }}>
                        <span className="card-title" style={{ color: 'var(--danger)' }}>🗑 Hromadné mazání leadů (NOVY)</span>
                        <span style={{ fontSize: 12, color: 'var(--gray-400)' }}>
              Natvrdo smaže z DB · čísla půjdou znovu importovat
            </span>
                    </div>
                    <div className="card-body">
                        <div className="alert alert-danger mb-16">
                            ⚠️ <strong>Pozor!</strong> Leady budou trvale smazány včetně všech záznamů. Tuto akci nelze vrátit.
                        </div>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                            <div className="form-group" style={{ margin: 0, minWidth: 200 }}>
                                <label className="form-label">Agent</label>
                                <select className="form-select" value={deleteAgentId} onChange={(e) => { setDeleteAgentId(e.target.value); setDeleteConfirm(false); }}>
                                    {AGENTS.map(a => <option key={a.id} value={a.id}>{a.name} — {a.description}</option>)}
                                </select>
                            </div>
                            <div className="form-group" style={{ margin: 0, minWidth: 120 }}>
                                <label className="form-label">Počet leadů</label>
                                <input
                                    type="number" className="form-input" min={1} max={10000}
                                    value={deleteCount}
                                    onChange={(e) => { setDeleteCount(Math.max(1, Number(e.target.value))); setDeleteConfirm(false); }}
                                />
                            </div>
                            <button
                                className={`btn ${deleteConfirm ? 'btn-danger' : 'btn-outline'}`}
                                onClick={handleDelete}
                                disabled={deleting}
                                style={{ marginBottom: 1 }}
                            >
                                {deleting
                                    ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Mažu...</>
                                    : deleteConfirm
                                        ? `⚠️ POTVRDIT smazání ${deleteCount} leadů`
                                        : `🗑 Smazat ${deleteCount} leadů`
                                }
                            </button>
                            {deleteConfirm && (
                                <button
                                    className="btn btn-outline"
                                    onClick={() => setDeleteConfirm(false)}
                                    style={{ marginBottom: 1 }}
                                >
                                    ✕ Zrušit
                                </button>
                            )}
                        </div>
                        {deleteError && <div className="alert alert-danger mt-8">⚠️ {deleteError}</div>}
                        {deleteResult && <div className="alert alert-success mt-8">✅ {deleteResult}</div>}
                    </div>
                </div>
            )}

            {/* FILTRY */}
            <div className="card mb-16">
                <div className="card-body" style={{ padding: '14px 20px' }}>
                    <form onSubmit={handleSearch} className="filters-bar">
                        <input
                            type="text" className="form-input search-input"
                            placeholder="🔍 Hledat telefon, firma, kontakt..."
                            value={searchInput}
                            onChange={(e) => setSearchInput(e.target.value)}
                        />
                        <select className="form-select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                            <option value="">Všechny statusy</option>
                            {ALL_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]?.label || s}</option>)}
                        </select>
                        <select className="form-select" value={filterAssignedTo} onChange={(e) => setFilterAssignedTo(e.target.value)}>
                            <option value="">Všichni agenti</option>
                            {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                        </select>
                        <button type="submit" className="btn btn-primary">Hledat</button>
                        {(filterStatus !== 'NOVY' || filterSearch || filterAssignedTo !== AI_AGENT_ID) && (
                            <button type="button" className="btn btn-outline" onClick={() => {
                                setFilterStatus('NOVY');
                                setFilterSearch('');
                                setSearchInput('');
                                setFilterAssignedTo(AI_AGENT_ID);
                            }}>
                                ✕ Reset
                            </button>
                        )}
                    </form>
                </div>
            </div>

            {/* TABULKA */}
            <div className="table-wrapper">
                {loading ? (
                    <div className="loading-spinner"><span className="spinner" />Načítám leady...</div>
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
                                        <div style={{ fontWeight: 600, fontSize: 13 }}>{lead.companyName || '—'}</div>
                                        {lead.contactPerson && <div className="td-muted">{lead.contactPerson}</div>}
                                    </td>
                                    <td>
                      <span className={`badge ${STATUS_LABELS[lead.status]?.badge || 'badge-gray'}`}>
                        {STATUS_LABELS[lead.status]?.label || lead.status}
                      </span>
                                    </td>
                                    <td className="td-muted">{lead.assignedTo?.fullName || '—'}</td>
                                    <td>
                                        {aiLog?.recordingUrl ? (
                                            <div className="audio-player">
                                                {playingUrl === aiLog.recordingUrl ? (
                                                    <audio
                                                        src={aiLog.recordingUrl} controls autoPlay
                                                        style={{ width: 200, height: 28 }}
                                                        onEnded={() => setPlayingUrl(null)}
                                                    />
                                                ) : (
                                                    <button className="btn btn-outline btn-sm" onClick={() => setPlayingUrl(aiLog.recordingUrl)}>
                                                        ▶ Přehrát
                                                    </button>
                                                )}
                                            </div>
                                        ) : <span className="td-muted">—</span>}
                                    </td>
                                    <td className="td-muted">{formatDuration(aiLog?.duration)}</td>
                                    <td style={{ maxWidth: 220 }}>
                                        {aiLog?.aiNotes ? (
                                            <span style={{
                                                fontSize: 12, color: 'var(--gray-600)',
                                                display: '-webkit-box', WebkitLineClamp: 2,
                                                WebkitBoxOrient: 'vertical', overflow: 'hidden',
                                            }} title={aiLog.aiNotes}>
                          {aiLog.aiNotes}
                        </span>
                                        ) : <span className="td-muted">—</span>}
                                    </td>
                                    <td className="td-muted" style={{ whiteSpace: 'nowrap' }}>
                                        {new Date(lead.updatedAt).toLocaleDateString('cs-CZ', {
                                            day: '2-digit', month: '2-digit', year: '2-digit',
                                            hour: '2-digit', minute: '2-digit',
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
                            <button className="pagination-btn" onClick={() => setPage(1)} disabled={page === 1}>«</button>
                            <button className="pagination-btn" onClick={() => setPage(p => p - 1)} disabled={page === 1}>‹</button>
                            {renderPageNumbers().map((p) => (
                                <button key={p} className={`pagination-btn ${p === page ? 'active' : ''}`} onClick={() => setPage(p)}>
                                    {p}
                                </button>
                            ))}
                            <button className="pagination-btn" onClick={() => setPage(p => p + 1)} disabled={page === totalPages}>›</button>
                            <button className="pagination-btn" onClick={() => setPage(totalPages)} disabled={page === totalPages}>»</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default Dashboard;