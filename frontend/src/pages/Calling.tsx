import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    getBatchStatus, getTwilioNumber, getAvgDuration,
    startAICalling, BatchStatus, AvgDuration,
} from '../api';

type CallingStep = 'setup' | 'reauth' | 'calling' | 'done';

interface AgentOption {
    id: string;
    name: string;
    description: string;
    pitch: string;
    successLine: string;
}

const AGENTS: AgentOption[] = [
    {
        id: '53c65ca7-68bc-4948-83e5-35a64c17f0fb',
        name: 'Eva V1',
        description: 'VIP ceník do SMS',
        pitch: 'Volám z T-Mobile partner, můžu vám do SMS poslat naprosto NEZÁVAZNĚ náš VIP ceník?',
        successLine: 'Skvěle! Kolega se ozve v krátkém hovoru a připraví Vám ho na míru. Hezký den!',
    },
    {
        id: 'aeec78ff-a86b-4cab-b33a-adeb7c94f08e',
        name: 'Eva V2',
        description: 'Neveřejné slevy — kontrola zdarma',
        pitch: 'T-Mobile partner s neveřejnými slevami u telefonu, můžu Vám domluvit krátkou, nezávaznou kontrolu zdarma od našeho specialisty?',
        successLine: 'Super, kolega se ozve hned, jak se k Vám dostane. Hezký den!',
    },
    {
        id: 'e7a469bb-4783-4f96-b961-03dd503e5bfa',
        name: 'Eva V3',
        description: 'Neveřejné slevy — krátký hovor',
        pitch: 'T-Mobile partner s neveřejnými slevami u telefonu, můžu Vám domluvit krátký nezávazný hovor s naším specialistou?',
        successLine: 'Super, kolega se ozve hned, jak se k Vám dostane. Hezký den!',
    },
    {
        id: 'f4adb349-70c3-4e63-8670-81f6c177f61d',
        name: 'Eva V4',
        description: 'Šetříme 40% — krátký hovor',
        pitch: 'T-Mobile partner u telefonu, šetřím svým klientům až 40% nákladů, můžu Vám domluvit krátký nezávazný hovor s naším specialistou?',
        successLine: 'Super, kolega se ozve hned, jak se k Vám dostane. Hezký den!',
    },
    {
        id: 'ffbabfc8-08e0-4dae-8a02-f9d7865f2bd9',
        name: 'Eva V5',
        description: 'Dvoustupňová kvalifikace (experiment)',
        pitch: 'Volám z T-Mobile partner, platíte za svůj mobilní tarif s neomezenými daty víc jak 500Kč měsíčně? → [ANO] → Chcete, aby Vás nezávazně kontaktoval náš specialista s lepší cenou?',
        successLine: 'Super, kolega se ozve hned, jak se k Vám dostane. Hezký den!',
    },
];

const MAX_WORKERS = 5;
const WORKER_PHONES = [
    '+420228810401',
    '+420228810985',
    '+420228811207',
    '+420228810644',
    '+420228811306',
];

const Calling: React.FC = () => {
    const [step, setStep] = useState<CallingStep>('setup');
    const [selectedAgent, setSelectedAgent] = useState<AgentOption>(AGENTS[0]);
    const [maxCalls, setMaxCalls] = useState<number>(100);
    const [workers, setWorkers] = useState<number>(1);
    const [twilioNumber, setTwilioNumber] = useState<string>('');
    const [avgDuration, setAvgDuration] = useState<AvgDuration | null>(null);
    const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
    const [novyCount, setNovyCount] = useState<number>(0);
    const [loadingMeta, setLoadingMeta] = useState(true);
    const [password, setPassword] = useState('');
    const [reauthError, setReauthError] = useState('');
    const [reauthLoading, setReauthLoading] = useState(false);
    const [startedAt, setStartedAt] = useState<Date | null>(null);
    const [error, setError] = useState('');

    const pollRef = useRef<NodeJS.Timeout | null>(null);

    const loadMeta = useCallback(async (agentId: string) => {
        setLoadingMeta(true);
        try {
            const [numRes, durRes, statusRes] = await Promise.all([
                getTwilioNumber(),
                getAvgDuration(),
                getBatchStatus(agentId),
            ]);
            setTwilioNumber(numRes.phone);
            setAvgDuration(durRes);
            setBatchStatus(statusRes);
            setNovyCount(statusRes.queueSize);
            setMaxCalls(Math.min(100, statusRes.queueSize));
        } catch (err) {
            console.error('Failed to load meta:', err);
        } finally {
            setLoadingMeta(false);
        }
    }, []);

    useEffect(() => {
        loadMeta(selectedAgent.id);
    }, [selectedAgent, loadMeta]);

    const startPolling = useCallback(() => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
            try {
                const status = await getBatchStatus(selectedAgent.id);
                setBatchStatus(status);
                if (!status.isRunning && step === 'calling') {
                    clearInterval(pollRef.current!);
                    setStep('done');
                }
            } catch (err) {
                console.error('Polling error:', err);
            }
        }, 3000);
    }, [step, selectedAgent.id]);

    useEffect(() => {
        if (step === 'calling') startPolling();
        return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }, [step, startPolling]);

    const estimateTime = (calls: number, workerCount: number = 1): string => {
        if (!avgDuration) return '—';
        const callsPerWorker = Math.ceil(calls / workerCount);
        const totalSeconds = callsPerWorker * avgDuration.totalPerCall;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        if (hours > 0) return `~${hours}h ${minutes}min`;
        return `~${minutes}min`;
    };

    const remainingTime = (): string => {
        if (!batchStatus || !avgDuration) return '—';
        const callsPerWorker = Math.ceil(batchStatus.queueSize / workers);
        const totalSeconds = callsPerWorker * avgDuration.totalPerCall;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        if (hours > 0) return `~${hours}h ${minutes}min`;
        if (minutes > 0) return `~${minutes}min`;
        return '< 1 min';
    };

    const progressPercent = (): number => {
        if (!batchStatus) return 0;
        const total = batchStatus.today.completed + batchStatus.queueSize;
        if (total === 0) return 0;
        return Math.round((batchStatus.today.completed / total) * 100);
    };

    const handleMaxCallsChange = (value: number) => {
        const capped = Math.max(1, Math.min(value, novyCount));
        setMaxCalls(capped);
    };

    const handleAgentChange = (agentId: string) => {
        const agent = AGENTS.find(a => a.id === agentId) || AGENTS[0];
        setSelectedAgent(agent);
    };

    const handleReauth = async (e: React.FormEvent) => {
        e.preventDefault();
        setReauthError('');
        setReauthLoading(true);

        try {
            const res = await fetch('/api/ai-calls/verify-password', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });

            if (!res.ok) {
                const data = await res.json();
                setReauthError(data.error?.message || 'Nesprávné heslo');
                setPassword('');
                setReauthLoading(false);
                return;
            }

            await startAICalling(maxCalls, selectedAgent.id, workers);
            const status = await getBatchStatus(selectedAgent.id);
            setBatchStatus(status);
            setStartedAt(new Date());
            setStep('calling');
        } catch (err: any) {
            setReauthError(err.message || 'Chyba při spuštění');
        } finally {
            setReauthLoading(false);
        }
    };

    const formatDuration = (sec: number): string => {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };

    const handleReset = () => {
        setStep('setup');
        setPassword('');
        setReauthError('');
        setError('');
        setBatchStatus(null);
        setStartedAt(null);
        if (pollRef.current) clearInterval(pollRef.current);
        loadMeta(selectedAgent.id);
    };

    const isV5 = selectedAgent.id === 'ffbabfc8-08e0-4dae-8a02-f9d7865f2bd9';

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">AI Volání</h1>
                    <p className="page-subtitle">Spuštění dávky hovorů přes AI agenta</p>
                </div>
            </div>

            {error && <div className="alert alert-danger mb-16">⚠️ {error}</div>}

            {/* ── KROK 1: NASTAVENÍ ── */}
            {step === 'setup' && (
                <div style={{ maxWidth: 580 }}>
                    <div className="card mb-16">
                        <div className="card-header">
                            <span className="card-title">📞 Konfigurace dávky</span>
                        </div>
                        <div className="card-body">

                            {/* Výběr agenta */}
                            <div className="form-group">
                                <label className="form-label">AI Agent</label>
                                <select
                                    className="form-select"
                                    value={selectedAgent.id}
                                    onChange={(e) => handleAgentChange(e.target.value)}
                                >
                                    {AGENTS.map(agent => (
                                        <option key={agent.id} value={agent.id}>
                                            {agent.name} — {agent.description}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* Pitch preview */}
                            <div style={{
                                background: isV5 ? '#fffbeb' : '#f8faff',
                                border: `1px solid ${isV5 ? '#fde68a' : '#c7d7f9'}`,
                                borderRadius: 'var(--radius)',
                                padding: '12px 14px',
                                marginBottom: 16,
                            }}>
                                {isV5 && (
                                    <div style={{ fontSize: 11, fontWeight: 600, color: '#d97706', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                                        🧪 Experimentální — dvoustupňová kvalifikace
                                    </div>
                                )}
                                <div style={{ fontSize: 11, fontWeight: 600, color: isV5 ? '#d97706' : 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
                                    🎙 {isV5 ? 'Otázka 1' : 'Pitch věta'}
                                </div>
                                <div style={{ fontSize: 13, color: 'var(--gray-800)', lineHeight: 1.6, fontStyle: 'italic' }}>
                                    {isV5
                                        ? '„Volám z T-Mobile partner, platíte za svůj mobilní tarif s neomezenými daty víc jak 500Kč měsíčně?"'
                                        : `„${selectedAgent.pitch}"`
                                    }
                                </div>
                                {isV5 && (
                                    <>
                                        <div style={{ fontSize: 11, fontWeight: 600, color: '#d97706', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 10, marginBottom: 6 }}>
                                            🎙 Otázka 2 (pouze pokud ANO)
                                        </div>
                                        <div style={{ fontSize: 13, color: 'var(--gray-800)', lineHeight: 1.6, fontStyle: 'italic' }}>
                                            „Chcete, aby Vás nezávazně kontaktoval náš specialista s lepší cenou?"
                                        </div>
                                    </>
                                )}
                                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--success)', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 10, marginBottom: 6 }}>
                                    ✅ Při souhlasu
                                </div>
                                <div style={{ fontSize: 13, color: 'var(--gray-700)', lineHeight: 1.6, fontStyle: 'italic' }}>
                                    „{selectedAgent.successLine}"
                                </div>
                            </div>

                            {/* Výběr počtu workerů */}
                            <div className="form-group">
                                <label className="form-label">
                                    Počet workerů (paralelní volání)
                                    <span style={{ fontWeight: 400, color: 'var(--gray-400)', marginLeft: 8, fontSize: 12 }}>
                                        max {MAX_WORKERS}
                                    </span>
                                </label>
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    {Array.from({ length: MAX_WORKERS }, (_, i) => i + 1).map(n => (
                                        <button
                                            key={n}
                                            type="button"
                                            className={`btn ${workers === n ? 'btn-primary' : 'btn-outline'}`}
                                            style={{ minWidth: 44 }}
                                            onClick={() => setWorkers(n)}
                                        >
                                            {n}
                                        </button>
                                    ))}
                                </div>
                                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--gray-500)' }}>
                                    {WORKER_PHONES.slice(0, workers).map((phone, i) => (
                                        <span key={phone} style={{ marginRight: 10, fontFamily: 'monospace', color: 'var(--primary)' }}>
                                            W{i + 1}: {phone}
                                        </span>
                                    ))}
                                </div>
                            </div>

                            {/* Telefonní číslo — skryjeme pokud workers > 1 */}
                            {workers === 1 && (
                                <div className="form-group">
                                    <label className="form-label">Volající číslo</label>
                                    <div style={{
                                        padding: '9px 12px',
                                        background: 'var(--gray-50)',
                                        border: '1px solid var(--gray-200)',
                                        borderRadius: 'var(--radius)',
                                        fontFamily: 'monospace',
                                        fontSize: 15,
                                        fontWeight: 700,
                                        color: 'var(--primary)',
                                    }}>
                                        {twilioNumber || '—'}
                                    </div>
                                </div>
                            )}

                            {/* Počet NOVY leadů */}
                            <div className="form-group">
                                <label className="form-label">Dostupné leady ke kontaktování</label>
                                {loadingMeta ? (
                                    <div className="loading-spinner" style={{ padding: '8px 0', justifyContent: 'flex-start' }}>
                                        <span className="spinner" /> Načítám...
                                    </div>
                                ) : (
                                    <div style={{
                                        padding: '9px 12px',
                                        background: novyCount > 0 ? 'var(--success-light)' : 'var(--danger-light)',
                                        border: `1px solid ${novyCount > 0 ? '#bbf7d0' : '#fecaca'}`,
                                        borderRadius: 'var(--radius)',
                                        fontWeight: 700,
                                        fontSize: 18,
                                        color: novyCount > 0 ? 'var(--success)' : 'var(--danger)',
                                    }}>
                                        {novyCount.toLocaleString('cs-CZ')} leadů se statusem NOVY
                                    </div>
                                )}
                            </div>

                            {/* Počet hovorů */}
                            <div className="form-group">
                                <label className="form-label">
                                    Počet hovorů v dávce
                                    <span style={{ fontWeight: 400, color: 'var(--gray-400)', marginLeft: 8, fontSize: 12 }}>
                                        (max {novyCount.toLocaleString('cs-CZ')})
                                    </span>
                                </label>
                                <input
                                    type="number"
                                    className="form-input"
                                    min={1}
                                    max={novyCount}
                                    value={maxCalls}
                                    onChange={(e) => handleMaxCallsChange(Number(e.target.value))}
                                    disabled={novyCount === 0 || loadingMeta}
                                />
                                {maxCalls >= novyCount && novyCount > 0 && (
                                    <div style={{ fontSize: 12, color: 'var(--warning)', marginTop: 4 }}>
                                        ⚠️ Voláš všechny dostupné leady
                                    </div>
                                )}
                            </div>

                            {/* Odhad času */}
                            {avgDuration && novyCount > 0 && (
                                <div className="alert alert-info">
                                    <div>
                                        <div style={{ fontWeight: 600, marginBottom: 4 }}>
                                            ⏱ Odhadovaný čas: {estimateTime(maxCalls, workers)}
                                            {workers > 1 && (
                                                <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 8, color: 'var(--primary)' }}>
                                                    ({workers}× rychleji)
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ fontSize: 12 }}>
                                            Průměrný hovor: {formatDuration(avgDuration.avgDuration)} + {avgDuration.overhead}s overhead
                                            {avgDuration.sampleSize > 0 && ` · z ${avgDuration.sampleSize} hovorů`}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {novyCount === 0 && !loadingMeta && (
                                <div className="alert alert-danger">
                                    ❌ Žádné leady se statusem NOVY pro tohoto agenta. Importuj leady nebo zařaď nedovolané zpět.
                                </div>
                            )}

                            <button
                                className="btn btn-primary btn-lg w-full"
                                onClick={() => setStep('reauth')}
                                disabled={novyCount === 0 || loadingMeta}
                            >
                                Pokračovat k ověření →
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── KROK 2: RE-AUTH ── */}
            {step === 'reauth' && (
                <div style={{ maxWidth: 460 }}>
                    <div className="card">
                        <div className="card-header">
                            <span className="card-title">🔐 Potvrzení spuštění</span>
                        </div>
                        <div className="card-body">
                            <div className="alert alert-warning mb-16">
                                <div>
                                    Agent: <strong>{selectedAgent.name}</strong> — {selectedAgent.description}
                                    <br />
                                    Počet hovorů: <strong>{maxCalls.toLocaleString('cs-CZ')}</strong>
                                    <br />
                                    Workeři: <strong>{workers}×</strong>
                                    {' '}
                                    <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
                                        ({WORKER_PHONES.slice(0, workers).join(', ')})
                                    </span>
                                    <br />
                                    Odhadovaný čas: <strong>{estimateTime(maxCalls, workers)}</strong>
                                    <br /><br />
                                    Pro potvrzení zadej své heslo.
                                </div>
                            </div>

                            {reauthError && (
                                <div className="alert alert-danger mb-16">⚠️ {reauthError}</div>
                            )}

                            <form onSubmit={handleReauth}>
                                <div className="form-group">
                                    <label className="form-label">Heslo</label>
                                    <input
                                        type="password"
                                        className="form-input"
                                        placeholder="••••••••••••"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        required
                                        autoFocus
                                        disabled={reauthLoading}
                                    />
                                </div>

                                <div style={{ display: 'flex', gap: 10 }}>
                                    <button
                                        type="button"
                                        className="btn btn-outline"
                                        onClick={() => setStep('setup')}
                                        disabled={reauthLoading}
                                    >
                                        ← Zpět
                                    </button>
                                    <button
                                        type="submit"
                                        className="btn btn-success btn-lg"
                                        style={{ flex: 1 }}
                                        disabled={reauthLoading || !password}
                                    >
                                        {reauthLoading ? (
                                            <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Spouštím...</>
                                        ) : (
                                            `🚀 Spustit ${selectedAgent.name} (${workers} worker${workers > 1 ? 'y' : ''})`
                                        )}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            )}

            {/* ── KROK 3: PROBÍHÁ VOLÁNÍ ── */}
            {step === 'calling' && batchStatus && (
                <div style={{ maxWidth: 640 }}>
                    <div style={{
                        background: isV5 ? '#fffbeb' : 'var(--primary-light)',
                        border: `1px solid ${isV5 ? '#fde68a' : '#bfdbfe'}`,
                        borderRadius: 'var(--radius)',
                        padding: '8px 14px',
                        fontSize: 13,
                        color: isV5 ? '#d97706' : 'var(--primary)',
                        fontWeight: 600,
                        marginBottom: 12,
                    }}>
                        {isV5 ? '🧪' : '🤖'} {selectedAgent.name} · {workers} worker{workers > 1 ? 'y' : ''} · {isV5 ? 'Dvoustupňová kvalifikace (experiment)' : `„${selectedAgent.pitch.slice(0, 50)}..."`}
                    </div>

                    <div className="live-feed mb-16">
                        <span className="live-dot" />
                        {batchStatus.isRunning && batchStatus.currentCall ? (
                            <span>
                                Právě volám: <strong>{batchStatus.currentCall.phone}</strong>
                                {batchStatus.currentCall.companyName && (
                                    <span style={{ color: '#86efac', marginLeft: 8 }}>
                                        {batchStatus.currentCall.companyName}
                                    </span>
                                )}
                            </span>
                        ) : (
                            <span style={{ color: '#fbbf24' }}>⏳ Připravuji další hovor...</span>
                        )}
                    </div>

                    <div className="card mb-16">
                        <div className="card-body">
                            <div className="flex justify-between items-center mb-8">
                                <span style={{ fontWeight: 600 }}>Průběh dávky</span>
                                <span style={{ fontSize: 13, color: 'var(--gray-500)' }}>
                                    {batchStatus.today.completed} hovorů dokončeno
                                </span>
                            </div>
                            <div className="progress-wrapper">
                                <div className="progress-bar" style={{ width: `${progressPercent()}%` }} />
                            </div>
                            <div className="flex justify-between items-center mt-8">
                                <span style={{ fontSize: 12, color: 'var(--gray-400)' }}>
                                    {progressPercent()}% dokončeno
                                </span>
                                <span style={{ fontSize: 12, color: 'var(--gray-500)', fontWeight: 600 }}>
                                    Zbývá: {remainingTime()}
                                </span>
                            </div>
                        </div>
                    </div>

                    <div className="stats-grid mb-16">
                        <div className="stat-card">
                            <div className="stat-label">Celkem hovorů</div>
                            <div className="stat-value primary">{batchStatus.today.completed}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Zájem ✅</div>
                            <div className="stat-value success">{batchStatus.today.interested}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Nezvedl</div>
                            <div className="stat-value warning">{batchStatus.today.noAnswer}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Odmítnuto</div>
                            <div className="stat-value danger">{batchStatus.today.rejected}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Konverze</div>
                            <div className="stat-value primary">{batchStatus.today.conversionRate}%</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Prům. délka</div>
                            <div className="stat-value">
                                {batchStatus.today.avgDuration > 0 ? formatDuration(batchStatus.today.avgDuration) : '—'}
                            </div>
                        </div>
                    </div>

                    <div className="alert alert-info">
                        💡 Stránka se automaticky aktualizuje každé 3 sekundy. Nezavírej okno prohlížeče.
                    </div>
                </div>
            )}

            {/* ── KROK 4: DOKONČENO ── */}
            {step === 'done' && batchStatus && (
                <div style={{ maxWidth: 640 }}>
                    <div className="alert alert-success mb-24" style={{ fontSize: 16 }}>
                        🎉 Dávka dokončena! Agent: <strong>{selectedAgent.name}</strong>
                        {startedAt && (
                            <span style={{ marginLeft: 8, fontSize: 13, opacity: 0.8 }}>
                                · Spuštěno: {startedAt.toLocaleTimeString('cs-CZ')}
                            </span>
                        )}
                    </div>

                    <div className="stats-grid mb-24">
                        <div className="stat-card">
                            <div className="stat-label">Celkem hovorů</div>
                            <div className="stat-value primary">{batchStatus.today.completed}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Zájem ✅</div>
                            <div className="stat-value success">{batchStatus.today.interested}</div>
                            <div className="stat-sub">CHCE_KONTAKT_AI</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Nezvedl</div>
                            <div className="stat-value warning">{batchStatus.today.noAnswer}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Odmítnuto</div>
                            <div className="stat-value danger">{batchStatus.today.rejected}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Odkládá</div>
                            <div className="stat-value warning">{batchStatus.today.callback}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Konverze</div>
                            <div className="stat-value primary">{batchStatus.today.conversionRate}%</div>
                            <div className="stat-sub">zájem / dokončeno</div>
                        </div>
                    </div>

                    <div style={{ display: 'flex', gap: 12 }}>
                        <button className="btn btn-primary btn-lg" onClick={handleReset}>
                            🔄 Spustit novou dávku
                        </button>
                        <a href="/crm/history" className="btn btn-outline btn-lg">
                            📊 Zobrazit historii dávek
                        </a>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Calling;