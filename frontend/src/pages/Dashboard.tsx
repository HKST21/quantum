import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

const API_BASE = '/api';
const POLLING_INTERVAL_MS = 3000;

type LeadStatus = 'NOVY' | 'NEZVEDL_TELEFON';

interface Agent {
    id: string;
    fullName: string;
    email: string;
}

interface WorkerPhone {
    worker: number;
    phone: string;
}

interface BatchStatus {
    isRunning: boolean;
    total: number;
    completed: number;
    successful: number;
    failed: number;
    inProgress: number;
    startedAt: string | null;
    batchName: string | null;
}

interface RunningCall {
    callSid: string;
    leadId: string;
    company: string;
    phone: string;
    status: string;
    startedAt: string;
    worker: number;
}

const Dashboard: React.FC = () => {
    const navigate = useNavigate();

    // Konfigurace kampaně
    const [batchName, setBatchName] = useState<string>('');
    const [agents, setAgents] = useState<Agent[]>([]);
    const [selectedAgentId, setSelectedAgentId] = useState<string>('');
    const [workers, setWorkers] = useState<number>(1);
    const [workerPhones, setWorkerPhones] = useState<WorkerPhone[]>([]);
    const [numbersToCall, setNumbersToCall] = useState<number>(10);
    const [selectedStatus, setSelectedStatus] = useState<LeadStatus>('NOVY');
    const [availableLeads, setAvailableLeads] = useState<number>(0);
    const [promptPreview, setPromptPreview] = useState<{ pitch: string; consent: string } | null>(null);

    // Cesta volání - Twilio pevná vs Odorik mobilní
    const [callingRoute, setCallingRoute] = useState<'twilio' | 'odorik'>('twilio');

    // Live status
    const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
    const [runningCalls, setRunningCalls] = useState<RunningCall[]>([]);
    const [totalToday, setTotalToday] = useState<number>(0);

    // Modal
    const [showResults, setShowResults] = useState<boolean>(false);
    const [todayResults, setTodayResults] = useState<any[]>([]);

    // ================ Loading & error ================
    const [starting, setStarting] = useState(false);
    const [stopping, setStopping] = useState(false);
    const [error, setError] = useState<string>('');

    // ================ Fetch agents ================
    useEffect(() => {
        const fetchAgents = async () => {
            try {
                const res = await fetch(`${API_BASE}/users?role=SALES`, { credentials: 'include' });
                if (!res.ok) return;
                const data = await res.json();
                const evaAgents = (data.users || []).filter((u: any) =>
                    u.email?.toLowerCase().includes('eva') || u.fullName?.toLowerCase().includes('eva')
                );
                setAgents(evaAgents);
                if (evaAgents.length > 0 && !selectedAgentId) {
                    setSelectedAgentId(evaAgents[0].id);
                }
            } catch {
                // silent
            }
        };
        fetchAgents();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ================ Fetch worker phones při změně workers ================
    useEffect(() => {
        // Odorik má hardcoded workers, nefetchuj
        if (callingRoute === 'odorik') return;

        const fetchWorkerPhones = async () => {
            try {
                const res = await fetch(`${API_BASE}/batch-calls/twilio-number?workers=${workers}`, {
                    credentials: 'include',
                });
                if (!res.ok) return;
                const data = await res.json();
                setWorkerPhones(data.workers || []);
            } catch {
                // silent
            }
        };
        fetchWorkerPhones();
    }, [workers, callingRoute]);

    // ================ Fetch dostupné leady ================
    useEffect(() => {
        const fetchAvailableLeads = async () => {
            if (!selectedAgentId) return;
            try {
                const res = await fetch(
                    `${API_BASE}/leads?status=${selectedStatus}&assigned_to=${selectedAgentId}&count_only=true`,
                    { credentials: 'include' }
                );
                if (!res.ok) return;
                const data = await res.json();
                setAvailableLeads(data.count || 0);
            } catch {
                // silent
            }
        };
        fetchAvailableLeads();
    }, [selectedAgentId, selectedStatus]);

    // ================ Fetch prompt preview ================
    useEffect(() => {
        const fetchPromptPreview = async () => {
            if (!selectedAgentId) return;
            try {
                const res = await fetch(`${API_BASE}/users/${selectedAgentId}`, { credentials: 'include' });
                if (!res.ok) return;
                const data = await res.json();
                const promptVersion = data.user?.promptVersion || 'v1';

                const previews: Record<string, { pitch: string; consent: string }> = {
                    v1: {
                        pitch: '„Volám z T-Mobile partner, můžu vám do SMS poslat naprosto NEZÁVAZNĚ náš VIP ceník?"',
                        consent: '„Skvěle! Kolega se ozve v krátkém hovoru a připraví Vám ho na míru. Hezký den!"',
                    },
                    v2: {
                        pitch: '„Volám z T-Mobile partner, můžu vám do SMS poslat naprosto NEZÁVAZNĚ náš VIP ceník?"',
                        consent: '„Skvěle! Kolega se ozve v krátkém hovoru a připraví Vám ho na míru. Hezký den!"',
                    },
                    v5: {
                        pitch: '„Volám z T-Mobile partner, můžu vám do SMS poslat naprosto NEZÁVAZNĚ náš VIP ceník?"',
                        consent: '„Děkuji! Poslední dotaz, jaký počet telefonních čísel máte aktuálně u svého operátora?"',
                    },
                };
                setPromptPreview(previews[promptVersion] || previews.v1);
            } catch {
                // silent
            }
        };
        fetchPromptPreview();
    }, [selectedAgentId]);

    // ================ Polling batch status ================
    const fetchBatchStatus = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/batch-calls/batch-status`, { credentials: 'include' });
            if (!res.ok) return;
            const data = await res.json();
            setBatchStatus(data.status || null);
            setRunningCalls(data.runningCalls || []);
            setTotalToday(data.totalToday || 0);
        } catch {
            // silent
        }
    }, []);

    useEffect(() => {
        fetchBatchStatus();
        const interval = setInterval(fetchBatchStatus, POLLING_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [fetchBatchStatus]);

    // ================ START kampaně ================
    const handleStartBatch = async () => {
        if (!selectedAgentId) {
            setError('Vyberte agenta');
            return;
        }
        if (numbersToCall <= 0) {
            setError('Počet hovorů musí být > 0');
            return;
        }

        setError('');
        setStarting(true);

        try {
            // =====================================================
            // ODORIK CESTA - volá /api/ai-calls/start-odorik-calling
            // =====================================================
            if (callingRoute === 'odorik') {
                const res = await fetch(`${API_BASE}/ai-calls/start-odorik-calling`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        batchName: batchName || undefined,
                        agentUserId: selectedAgentId,
                        maxCalls: numbersToCall,
                        workers: 1, // Odorik zatím jen 1 worker
                        statusFilter: selectedStatus,
                    }),
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error?.message || 'Chyba spuštění Odorik kampaně');

                alert(`✅ Odorik kampaň spuštěna!\nBatch: ${data.batchName}\n${data.queuedLeads} leadů ve frontě\nSIP jméno: ${data.sipNames?.join(', ')}`);
                await fetchBatchStatus();
                return;
            }

            // =====================================================
            // TWILIO CESTA - PŮVODNÍ FLOW beze změny
            // =====================================================
            const res = await fetch(`${API_BASE}/batch-calls/start-batch`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    batchName: batchName || undefined,
                    agentUserId: selectedAgentId,
                    workerCount: workers,
                    numbersToCallCount: numbersToCall,
                    minCallIntervalSeconds: 0,
                    statusFilter: selectedStatus,
                }),
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error?.message || 'Chyba spuštění kampaně');

            alert(`✅ Kampaň spuštěna!\n${data.queuedLeads || numbersToCall} leadů ve frontě`);
            await fetchBatchStatus();
        } catch (err: any) {
            setError(err.message);
            alert(`❌ Chyba: ${err.message}`);
        } finally {
            setStarting(false);
        }
    };

    // ================ STOP kampaně ================
    const handleStopBatch = async () => {
        setStopping(true);
        try {
            const endpoint = callingRoute === 'odorik'
                ? `${API_BASE}/ai-calls/stop`
                : `${API_BASE}/ai-calls/stop`;

            const res = await fetch(endpoint, {
                method: 'POST',
                credentials: 'include',
            });
            if (!res.ok) throw new Error('Nepodařilo se zastavit');
            await fetchBatchStatus();
        } catch (err: any) {
            alert(`❌ Chyba: ${err.message}`);
        } finally {
            setStopping(false);
        }
    };

    // ================ Modal - dnešní výsledky ================
    const handleShowTodayResults = async () => {
        try {
            const res = await fetch(`${API_BASE}/batch-calls/batch-results?date=today`, {
                credentials: 'include',
            });
            if (!res.ok) return;
            const data = await res.json();
            setTodayResults(data.results || []);
            setShowResults(true);
        } catch {
            // silent
        }
    };

    const isRunning = batchStatus?.isRunning || false;
    const progress = batchStatus
        ? Math.round(((batchStatus.completed) / Math.max(batchStatus.total, 1)) * 100)
        : 0;

    return (
        <div className="dashboard-container">
            <div className="page-header">
                <h1>Dashboard</h1>
                <p className="page-subtitle">Přehled a spuštění AI kampaně</p>
            </div>

            {/* ==================== CESTA VOLÁNÍ (nový selektor) ==================== */}
            <div className="config-section" style={{ marginBottom: 16 }}>
                <div className="config-label" style={{ marginBottom: 12, fontSize: 14, fontWeight: 700 }}>
                    📡 Cesta volání
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    {/* Twilio pevná linka */}
                    <button
                        type="button"
                        onClick={() => setCallingRoute('twilio')}
                        disabled={isRunning}
                        style={{
                            padding: '16px',
                            border: callingRoute === 'twilio' ? '2px solid #3b82f6' : '1px solid #e5e7eb',
                            borderRadius: 8,
                            background: callingRoute === 'twilio' ? '#eff6ff' : 'white',
                            cursor: isRunning ? 'not-allowed' : 'pointer',
                            textAlign: 'left',
                            transition: 'all 0.15s',
                            opacity: isRunning ? 0.6 : 1,
                        }}
                    >
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
                            🏢 Twilio (pevná linka)
                        </div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>
                            Standardní cesta, max 5 paralelních hovorů
                        </div>
                    </button>

                    {/* Odorik mobilní */}
                    <button
                        type="button"
                        onClick={() => setCallingRoute('odorik')}
                        disabled={isRunning}
                        style={{
                            padding: '16px',
                            border: callingRoute === 'odorik' ? '2px solid #10b981' : '1px solid #e5e7eb',
                            borderRadius: 8,
                            background: callingRoute === 'odorik' ? '#ecfdf5' : 'white',
                            cursor: isRunning ? 'not-allowed' : 'pointer',
                            textAlign: 'left',
                            transition: 'all 0.15s',
                            opacity: isRunning ? 0.6 : 1,
                        }}
                    >
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
                            📱 Odorik (mobilní číslo)
                        </div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>
                            Klient vidí +420 703 614 594, zatím 1 worker
                        </div>
                    </button>
                </div>
            </div>

            {/* ==================== KONFIGURACE DÁVKY ==================== */}
            <div className="config-card">
                <h2>📞 Konfigurace dávky</h2>

                {/* Název kampaně */}
                <div className="config-section">
                    <label className="config-label">Název kampaně (volitelné)</label>
                    <input
                        type="text"
                        className="input"
                        value={batchName}
                        onChange={(e) => setBatchName(e.target.value)}
                        placeholder="např. Cold call ranní"
                        disabled={isRunning}
                    />
                </div>

                {/* Výběr agenta */}
                <div className="config-section">
                    <label className="config-label">AI Agent</label>
                    <select
                        className="input"
                        value={selectedAgentId}
                        onChange={(e) => setSelectedAgentId(e.target.value)}
                        disabled={isRunning}
                    >
                        {agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                                {agent.fullName} — {agent.email}
                            </option>
                        ))}
                    </select>
                </div>

                {/* Prompt preview */}
                {promptPreview && (
                    <div className="config-section" style={{ background: '#f9fafb', padding: 12, borderRadius: 8 }}>
                        <div style={{ marginBottom: 8, fontSize: 12, fontWeight: 600, color: '#3b82f6' }}>
                            📝 PITCH VĚTA
                        </div>
                        <div style={{ fontSize: 13, marginBottom: 12, fontStyle: 'italic' }}>
                            {promptPreview.pitch}
                        </div>
                        <div style={{ marginBottom: 8, fontSize: 12, fontWeight: 600, color: '#10b981' }}>
                            ✅ PŘI SOUHLASU
                        </div>
                        <div style={{ fontSize: 13, fontStyle: 'italic' }}>
                            {promptPreview.consent}
                        </div>
                    </div>
                )}

                {/* ==================== SEKCE WORKERŮ - KONDIČNÍ ==================== */}
                {callingRoute === 'twilio' ? (
                    /* TWILIO WORKERS - PŮVODNÍ SEKCE */
                    <div className="config-section">
                        <div className="config-label">
                            Počet workerů (paralelní volání) <span className="config-hint">max 5</span>
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {[1, 2, 3, 4, 5].map((n) => (
                                <button
                                    key={n}
                                    type="button"
                                    onClick={() => setWorkers(n)}
                                    disabled={isRunning}
                                    className={`btn worker-btn ${workers === n ? 'btn-primary' : 'btn-outline'}`}
                                    style={{ width: 60 }}
                                >
                                    {n}
                                </button>
                            ))}
                        </div>
                        {workerPhones.length > 0 && (
                            <div style={{ marginTop: 12, fontSize: 13 }}>
                                {workerPhones.map((wp) => (
                                    <div key={wp.worker} style={{ marginBottom: 4 }}>
                                        <span style={{ color: '#3b82f6', fontWeight: 600 }}>W{wp.worker}:</span>{' '}
                                        <code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: 4 }}>
                                            {wp.phone}
                                        </code>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ) : (
                    /* ODORIK WORKERS - HARDCODED 1 aktivní + 3 zamčené */
                    <div className="config-section">
                        <div className="config-label">
                            Počet workerů (paralelní volání) <span className="config-hint">Odorik: 1 aktivní</span>
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {[1, 2, 3, 4].map((num) => {
                                const isActive = num === 1;
                                return (
                                    <button
                                        key={num}
                                        type="button"
                                        disabled={!isActive || isRunning}
                                        title={!isActive ? 'Bude aktivní až po přidání dalšího SIP jména' : ''}
                                        style={{
                                            width: 60,
                                            height: 44,
                                            border: isActive ? '2px solid #10b981' : '1px solid #e5e7eb',
                                            borderRadius: 8,
                                            background: isActive ? '#ecfdf5' : '#f9fafb',
                                            color: isActive ? '#10b981' : '#9ca3af',
                                            fontWeight: 700,
                                            fontSize: 16,
                                            cursor: isActive && !isRunning ? 'pointer' : 'not-allowed',
                                        }}
                                    >
                                        {isActive ? num : '🔒'}
                                    </button>
                                );
                            })}
                        </div>
                        <div style={{ marginTop: 12, padding: 12, background: '#f9fafb', borderRadius: 8, fontSize: 13 }}>
                            <div style={{ color: '#374151', marginBottom: 4 }}>
                                <strong>W1:</strong>{' '}
                                <code style={{ background: 'white', padding: '2px 6px', borderRadius: 4 }}>hejda_test1</code>
                                {' → '}
                                <span style={{ color: '#10b981', fontWeight: 600 }}>+420 703 614 594</span>
                            </div>
                            <div style={{ color: '#9ca3af', fontSize: 12 }}>
                                Volající SIP: <code>+420 266 266 095</code> (Odorik pevná)
                            </div>
                        </div>
                    </div>
                )}

                {/* Volající číslo (Twilio only) */}
                {callingRoute === 'twilio' && workerPhones.length > 0 && (
                    <div className="config-section">
                        <label className="config-label">Volající číslo</label>
                        <div style={{
                            padding: 12,
                            background: '#eff6ff',
                            borderRadius: 8,
                            color: '#3b82f6',
                            fontWeight: 600
                        }}>
                            {workerPhones[0]?.phone}
                        </div>
                    </div>
                )}

                {/* Status filter */}
                <div className="config-section">
                    <label className="config-label">Status leadů k volání</label>
                    <select
                        className="input"
                        value={selectedStatus}
                        onChange={(e) => setSelectedStatus(e.target.value as LeadStatus)}
                        disabled={isRunning}
                    >
                        <option value="NOVY">NOVÝ (první kontakt)</option>
                        <option value="NEZVEDL_TELEFON">NEZVEDL_TELEFON (retry)</option>
                    </select>
                </div>

                {/* Dostupné leady */}
                <div className="config-section">
                    <label className="config-label">Dostupné leady ke kontaktování</label>
                    <div style={{
                        padding: 12,
                        background: availableLeads > 0 ? '#ecfdf5' : '#fef2f2',
                        borderRadius: 8,
                        color: availableLeads > 0 ? '#10b981' : '#dc2626',
                        fontWeight: 700,
                        fontSize: 18,
                    }}>
                        {availableLeads.toLocaleString()} leadů se statusem {selectedStatus}
                    </div>
                </div>

                {/* Počet hovorů */}
                <div className="config-section">
                    <label className="config-label">
                        Počet hovorů v dávce{' '}
                        <span className="config-hint">(max {availableLeads.toLocaleString()})</span>
                    </label>
                    <input
                        type="number"
                        className="input"
                        value={numbersToCall}
                        onChange={(e) => setNumbersToCall(Math.max(1, parseInt(e.target.value) || 0))}
                        min={1}
                        max={availableLeads}
                        disabled={isRunning}
                    />
                </div>

                {/* Chybová hláška */}
                {error && (
                    <div style={{
                        padding: 12,
                        background: '#fef2f2',
                        color: '#dc2626',
                        borderRadius: 8,
                        marginBottom: 16,
                        fontSize: 14,
                    }}>
                        ⚠️ {error}
                    </div>
                )}

                {/* Start / Stop tlačítka */}
                <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                    <button
                        onClick={handleStartBatch}
                        disabled={starting || isRunning || availableLeads === 0}
                        className="btn btn-primary"
                        style={{ flex: 1, padding: '12px', fontSize: 15, fontWeight: 700 }}
                    >
                        {starting ? '⏳ Spouštím...' : '🚀 Spustit AI volání'}
                    </button>

                    {isRunning && (
                        <button
                            onClick={handleStopBatch}
                            disabled={stopping}
                            className="btn btn-outline"
                            style={{ flex: 1, padding: '12px', fontSize: 15 }}
                        >
                            {stopping ? '⏳ Zastavuji...' : '⏹ Zastavit'}
                        </button>
                    )}
                </div>

                {/* Info indikátor cesty volání */}
                <div style={{
                    textAlign: 'center',
                    marginTop: 8,
                    fontSize: 12,
                    color: callingRoute === 'odorik' ? '#10b981' : '#3b82f6',
                    fontWeight: 600,
                }}>
                    {callingRoute === 'odorik'
                        ? '📱 Bude volat přes Odorik (mobilní CLIP +420 703 614 594)'
                        : '🏢 Bude volat přes Twilio (pevná linka)'}
                </div>
            </div>

            {/* ==================== LIVE STATUS ==================== */}
            {batchStatus && (
                <div className="stats-card" style={{ marginTop: 24 }}>
                    <h2>📊 Live status</h2>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 16 }}>
                        <div>
                            <div style={{ fontSize: 12, color: '#6b7280' }}>Celkem v dávce</div>
                            <div style={{ fontSize: 24, fontWeight: 700 }}>{batchStatus.total}</div>
                        </div>
                        <div>
                            <div style={{ fontSize: 12, color: '#6b7280' }}>Dokončeno</div>
                            <div style={{ fontSize: 24, fontWeight: 700, color: '#10b981' }}>{batchStatus.completed}</div>
                        </div>
                        <div>
                            <div style={{ fontSize: 12, color: '#6b7280' }}>Aktivní hovory</div>
                            <div style={{ fontSize: 24, fontWeight: 700, color: '#3b82f6' }}>{batchStatus.inProgress}</div>
                        </div>
                        <div>
                            <div style={{ fontSize: 12, color: '#6b7280' }}>Dnes celkem</div>
                            <div style={{ fontSize: 24, fontWeight: 700 }}>
                                <button
                                    onClick={handleShowTodayResults}
                                    style={{
                                        background: 'transparent',
                                        border: 'none',
                                        color: '#3b82f6',
                                        cursor: 'pointer',
                                        fontSize: 24,
                                        fontWeight: 700,
                                        padding: 0,
                                    }}
                                >
                                    {totalToday}
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Progress bar */}
                    {batchStatus.total > 0 && (
                        <div>
                            <div style={{
                                height: 8,
                                background: '#e5e7eb',
                                borderRadius: 4,
                                overflow: 'hidden',
                                marginBottom: 8,
                            }}>
                                <div style={{
                                    width: `${progress}%`,
                                    height: '100%',
                                    background: '#10b981',
                                    transition: 'width 0.3s',
                                }} />
                            </div>
                            <div style={{ fontSize: 12, color: '#6b7280', textAlign: 'center' }}>
                                {progress}% dokončeno ({batchStatus.completed} / {batchStatus.total})
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ==================== AKTIVNÍ HOVORY ==================== */}
            {runningCalls.length > 0 && (
                <div className="stats-card" style={{ marginTop: 24 }}>
                    <h2>☎ Aktivní hovory ({runningCalls.length})</h2>
                    <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                        {runningCalls.map((call) => (
                            <div key={call.callSid} style={{
                                padding: 12,
                                borderBottom: '1px solid #e5e7eb',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                            }}>
                                <div>
                                    <div style={{ fontWeight: 600 }}>{call.company}</div>
                                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                                        W{call.worker} · {call.phone} · {call.status}
                                    </div>
                                </div>
                                <div style={{ fontSize: 11, color: '#9ca3af' }}>
                                    {new Date(call.startedAt).toLocaleTimeString('cs-CZ')}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ==================== MODAL - dnešní výsledky ==================== */}
            {showResults && (
                <div style={{
                    position: 'fixed',
                    top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.5)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 1000,
                }} onClick={() => setShowResults(false)}>
                    <div style={{
                        background: 'white',
                        borderRadius: 12,
                        padding: 24,
                        maxWidth: 800,
                        width: '90%',
                        maxHeight: '80vh',
                        overflowY: 'auto',
                    }} onClick={(e) => e.stopPropagation()}>
                        <h2>Dnešní výsledky ({todayResults.length})</h2>
                        <div style={{ marginTop: 16 }}>
                            {todayResults.map((r: any, i: number) => (
                                <div key={i} style={{
                                    padding: 12,
                                    borderBottom: '1px solid #e5e7eb',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                }}>
                                    <div>
                                        <div style={{ fontWeight: 600 }}>{r.company}</div>
                                        <div style={{ fontSize: 12, color: '#6b7280' }}>
                                            {r.phone} · {r.outcome}
                                        </div>
                                    </div>
                                    <div>
                                        {new Date(r.startedAt).toLocaleTimeString('cs-CZ')}
                                    </div>
                                </div>
                            ))}
                        </div>
                        <button
                            onClick={() => setShowResults(false)}
                            className="btn btn-outline"
                            style={{ marginTop: 16 }}
                        >
                            Zavřít
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Dashboard;