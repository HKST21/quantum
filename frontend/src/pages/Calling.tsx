import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    getBatchStatus, getTwilioNumber, getAvgDuration, getOdorikConfig,
    startAICalling, stopAICalling, BatchStatus, AvgDuration, OdorikConfig, CallProvider, CallEngine, OdorikLine, CallMode,
} from '../api';
import BatchJobPanel from '../components/BatchJobPanel';

type CallingStep = 'setup' | 'reauth' | 'calling' | 'done';

interface AgentOption {
    id: string;
    name: string;
    description: string;
    pitch: string;
    pitchGemini?: string;
    secondQuestion?: string;
    successLine: string;
    engines: CallEngine[];
    isFacebookAgent?: boolean;
}

const AGENTS: AgentOption[] = [
    {
        id: '53c65ca7-68bc-4948-83e5-35a64c17f0fb',
        name: 'Eva V1',
        description: 'VIP ceník do SMS',
        pitch: 'Volám z T-Mobile partner, můžu vám do SMS poslat naprosto NEZÁVAZNĚ náš VIP ceník?',
        pitchGemini: 'Krásný den, slyšíme se? Volám jako AI z T-Mobile partner, můžu vám do SMS poslat naprosto NEZÁVAZNĚ náš VIP ceník?',
        successLine: 'Skvěle! Kolega se ozve v krátkém hovoru a připraví Vám ho na míru. Hezký den!',
        engines: ['openai', 'gemini'],
    },
    {
        id: 'dab796fa-bf16-4f99-812c-601a031049ce',
        name: 'Eva Gemini V2',
        description: 'Zjednodušený VIP ceník (pouze Gemini)',
        pitch: 'Krásný den, volám jako AI z T-Mobile partner, můžu vám do SMS poslat naprosto NEZÁVAZNĚ náš VIP ceník?',
        successLine: 'Skvěle! Kolega se ozve v krátkém hovoru a připraví Vám ho na míru. Hezký den!',
        engines: ['gemini'],
    },
    {
        id: 'ffbabfc8-08e0-4dae-8a02-f9d7865f2bd9',
        name: 'Eva V5',
        description: 'VIP ceník + počet čísel u operátora',
        pitch: 'Volám z T-Mobile partner, můžu vám do SMS poslat naprosto NEZÁVAZNĚ náš VIP ceník?',
        secondQuestion: 'Děkuji! Poslední dotaz, jaký počet telefonních čísel máte aktuálně u svého operátora?',
        successLine: 'Děkuji za odpověď! Kolega se ozve v krátkém hovoru a připraví Vám ceník na míru. Hezký den!',
        engines: ['openai', 'gemini'],
    },
    {
        id: '3aa4d37f-ebd7-49f9-a72f-c04ac33c057d',
        name: 'Eva FB V9',
        description: 'FB leady — telefon za 1 Kč (info)',
        pitch: 'Krásný den, volám jako AI z T-Mobile partner. Poslední šance telefonů za jednu korunu, chcete od nás nezávazně více informací?',
        successLine: 'Skvěle! Brzy Vám poskytneme více informací. Hezký den!',
        engines: ['gemini'],
        isFacebookAgent: true,
    },
];

const GEMINI_DEFAULT_AGENT_ID = 'dab796fa-bf16-4f99-812c-601a031049ce'; // Eva Gemini V2

const TWILIO_MAX_WORKERS = 5;
const TWILIO_WORKER_PHONES = [
    '+420228810401',
    '+420228810985',
    '+420228811207',
    '+420228810644',
    '+420228811306',
];

const ENGINE_LABELS: Record<CallEngine, { label: string; icon: string }> = {
    openai: { label: 'OpenAI', icon: '🧠' },
    gemini: { label: 'Gemini', icon: '✨' },
};

const ODORIK_LINE_LABELS: Record<OdorikLine, { label: string; icon: string }> = {
    mobilni: { label: 'Mobilní (790766)', icon: '📱' },
    pevna: { label: 'Pevná (793305)', icon: '☎️' },
    fb: { label: 'Facebook (7 linek)', icon: '📘' },
};

const ODORIK_LINE_DISPLAY_CLIP: Record<'mobilni' | 'pevna', string> = {
    mobilni: '703614594',
    pevna: '217217749',
};

const Calling: React.FC = () => {
    const [step, setStep] = useState<CallingStep>('setup');
    const [provider, setProvider] = useState<CallProvider>('twilio');
    const [engine, setEngine] = useState<CallEngine>('openai');
    const [odorikLine, setOdorikLine] = useState<OdorikLine>('mobilni');
    const [callMode, setCallMode] = useState<CallMode>('parallel');
    const [selectedAgent, setSelectedAgent] = useState<AgentOption>(AGENTS[0]);
    const [maxCalls, setMaxCalls] = useState<number>(100);
    const [workers, setWorkers] = useState<number>(1);
    const [twilioNumber, setTwilioNumber] = useState<string>('');
    const [odorikConfig, setOdorikConfig] = useState<OdorikConfig | null>(null);
    const [avgDuration, setAvgDuration] = useState<AvgDuration | null>(null);
    const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
    const [novyCount, setNovyCount] = useState<number>(0);
    const [loadingMeta, setLoadingMeta] = useState(true);
    const [password, setPassword] = useState('');
    const [reauthError, setReauthError] = useState('');
    const [reauthLoading, setReauthLoading] = useState(false);
    const [startedAt, setStartedAt] = useState<Date | null>(null);
    const [error, setError] = useState('');
    const [stopConfirm, setStopConfirm] = useState(false);
    const [stopping, setStopping] = useState(false);
    const [stopError, setStopError] = useState('');

    const pollRef = useRef<NodeJS.Timeout | null>(null);

    const isFbSelected = selectedAgent.isFacebookAgent === true;
    // Asterisk + Odorik = vlastní ústředna: jen Gemini, sekvenční rotace (FB agenti zatím ne)
    const isAsterisk = provider === 'asterisk' && !isFbSelected;
    const sequential = isFbSelected || isAsterisk;
    const availableAgents = AGENTS.filter(a => a.engines.includes(engine) && !(provider === 'asterisk' && a.isFacebookAgent));

    const handleEngineChange = (newEngine: CallEngine) => {
        setEngine(newEngine);

        if (newEngine === 'gemini') {
            const preferred = AGENTS.find(a => a.id === GEMINI_DEFAULT_AGENT_ID);
            if (preferred) {
                setSelectedAgent(preferred);
                return;
            }
        }

        const stillCompatible = AGENTS.filter(a => a.engines.includes(newEngine));
        if (!stillCompatible.find(a => a.id === selectedAgent.id)) {
            setSelectedAgent(stillCompatible[0]);
        }
    };

    const handleProviderChange = (newProvider: CallProvider) => {
        setProvider(newProvider);
        if (newProvider === 'asterisk') {
            setCallMode('rotating');
            setEngine('gemini');
            if (!selectedAgent.engines.includes('gemini')) {
                const preferred = AGENTS.find(a => a.id === GEMINI_DEFAULT_AGENT_ID);
                if (preferred) setSelectedAgent(preferred);
            }
        } else {
            setCallMode('parallel');
        }
    };

    useEffect(() => {
        if (isFbSelected) {
            setProvider('odorik');
            setOdorikLine('fb');
            setCallMode('rotating');
        } else if (odorikLine === 'fb') {
            setOdorikLine('mobilni');
            setCallMode('parallel');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedAgent]);

    useEffect(() => {
        const loadOdorikConfig = async () => {
            try {
                const cfg = await getOdorikConfig();
                setOdorikConfig(cfg);
            } catch (err) {
                console.error('Failed to load Odorik config:', err);
                setOdorikConfig({
                    lines: {
                        mobilni: { sipNames: [], maxWorkers: 0, phoneNumber: null },
                        pevna: { sipNames: [], maxWorkers: 0, phoneNumber: null },
                        fb: { identities: [], maxWorkers: 0 },
                    },
                });
            }
        };
        loadOdorikConfig();
    }, []);

    const standardOdorikLineConfig = (odorikLine === 'mobilni' || odorikLine === 'pevna')
        ? odorikConfig?.lines?.[odorikLine]
        : undefined;

    const fbConfig = odorikConfig?.lines?.fb;
    const fbIdentityCount = fbConfig?.identities?.length ?? 0;
    const fbUnavailable = isFbSelected && odorikConfig !== null && fbIdentityCount === 0;

    const maxWorkersAvailable = provider === 'twilio'
        ? TWILIO_MAX_WORKERS
        : provider === 'asterisk'
            ? 1
            : (standardOdorikLineConfig?.maxWorkers ?? 0);

    const workerLabels: string[] = provider === 'twilio'
        ? TWILIO_WORKER_PHONES
        : provider === 'asterisk'
            ? []
            : (standardOdorikLineConfig?.sipNames ?? []);

    const odorikUnavailable = provider === 'odorik' && !isFbSelected && odorikConfig !== null && maxWorkersAvailable === 0;

    useEffect(() => {
        if (!isFbSelected && maxWorkersAvailable > 0 && workers > maxWorkersAvailable) {
            setWorkers(maxWorkersAvailable);
        }
    }, [maxWorkersAvailable, workers, isFbSelected]);

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

    useEffect(() => { loadMeta(selectedAgent.id); }, [selectedAgent, loadMeta]);

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
        const effectiveWorkers = sequential ? 1 : workers;
        const callsPerWorker = Math.ceil(batchStatus.queueSize / effectiveWorkers);
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
        setMaxCalls(Math.max(1, Math.min(value, novyCount)));
    };

    const handleAgentChange = (agentId: string) => {
        setSelectedAgent(availableAgents.find(a => a.id === agentId) || availableAgents[0]);
    };

    const displayedPitch = engine === 'gemini' && selectedAgent.pitchGemini
        ? selectedAgent.pitchGemini
        : selectedAgent.pitch;

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

            await startAICalling(maxCalls, selectedAgent.id, isAsterisk ? 1 : workers, provider, engine, odorikLine, isAsterisk ? 'rotating' : callMode);
            setStopConfirm(false);
            setStopping(false);
            setStopError('');

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

    const handleStop = async () => {
        if (!stopConfirm) {
            setStopConfirm(true);
            return;
        }
        setStopConfirm(false);
        setStopError('');
        try {
            await stopAICalling(selectedAgent.id);
            setStopping(true);
        } catch (err: any) {
            setStopError(err.message || 'Zastavení se nezdařilo');
        }
    };

    const handleReset = () => {
        setStep('setup');
        setPassword('');
        setReauthError('');
        setError('');
        setBatchStatus(null);
        setStartedAt(null);
        setStopConfirm(false);
        setStopping(false);
        setStopError('');
        if (pollRef.current) clearInterval(pollRef.current);
        loadMeta(selectedAgent.id);
    };

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">AI Volání</h1>
                    <p className="page-subtitle">Spuštění dávky hovorů přes AI agenta</p>
                </div>
            </div>

            {error && <div className="alert alert-danger mb-16">⚠️ {error}</div>}

            {/* Živý stav dávky na ústředně + stažení logu (jen ADMIN, funguje nezávisle na tom, kdo dávku spustil) */}
            <BatchJobPanel />

            {step === 'setup' && (
                <div style={{ maxWidth: 580 }}>
                    <div className="card mb-16">
                        <div className="card-header">
                            <span className="card-title">📞 Konfigurace dávky</span>
                        </div>
                        <div className="card-body">

                            <div className="form-group">
                                <label className="form-label">AI Engine</label>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    {(Object.keys(ENGINE_LABELS) as CallEngine[]).map((eng) => (
                                        <button
                                            key={eng}
                                            type="button"
                                            className={`btn ${engine === eng ? 'btn-primary' : 'btn-outline'}`}
                                            onClick={() => handleEngineChange(eng)}
                                            disabled={isAsterisk && eng === 'openai'}
                                            title={isAsterisk && eng === 'openai' ? 'Asterisk + Odorik podporuje jen Gemini' : undefined}
                                        >
                                            {ENGINE_LABELS[eng].icon} {ENGINE_LABELS[eng].label}
                                        </button>
                                    ))}
                                </div>
                                {engine === 'gemini' && (
                                    <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 6 }}>
                                        ℹ️ Gemini je dostupné pro Eva V1, Eva Gemini V2, Eva V5 a Eva FB V9.
                                    </div>
                                )}
                                {isAsterisk && (
                                    <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 6 }}>
                                        ℹ️ Vlastní ústředna (Asterisk + Odorik) podporuje jen Gemini. Eva FB V9 zatím jede jen přes Odorik.
                                    </div>
                                )}
                            </div>

                            <div className="form-group">
                                <label className="form-label">AI Agent</label>
                                <select className="form-select" value={selectedAgent.id} onChange={(e) => handleAgentChange(e.target.value)}>
                                    {availableAgents.map(agent => (
                                        <option key={agent.id} value={agent.id}>
                                            {agent.name} — {agent.description}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {isFbSelected && (
                                <div className="alert alert-info mb-16" style={{ borderColor: '#7c3aed' }}>
                                    <div>
                                        📘 <strong>Facebook leady</strong> — tenhle agent volá VÝHRADNĚ přes dedikovaných
                                        7 Odorik linek v rotujícím módu. Poskytovatel a linka jsou uzamčené, výběr
                                        Twilia/mobilní/pevné linky je pro tenhle agent skrytý.
                                    </div>
                                </div>
                            )}

                            <div style={{ background: '#f8faff', border: '1px solid #c7d7f9', borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 16 }}>
                                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
                                    🎙 Pitch věta
                                </div>
                                <div style={{ fontSize: 13, color: 'var(--gray-800)', lineHeight: 1.6, fontStyle: 'italic' }}>
                                    „{displayedPitch}"
                                </div>
                                {selectedAgent.secondQuestion && (
                                    <>
                                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 10, marginBottom: 6 }}>
                                            🎙 Po souhlasu
                                        </div>
                                        <div style={{ fontSize: 13, color: 'var(--gray-800)', lineHeight: 1.6, fontStyle: 'italic' }}>
                                            „{selectedAgent.secondQuestion}"
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

                            {!isFbSelected && (
                                <div className="form-group">
                                    <label className="form-label">Poskytovatel volání</label>
                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                        <button
                                            type="button"
                                            className={`btn ${provider === 'twilio' ? 'btn-primary' : 'btn-outline'}`}
                                            onClick={() => handleProviderChange('twilio')}
                                        >
                                            ☎️ Twilio (pevná linka)
                                        </button>
                                        <button
                                            type="button"
                                            className={`btn ${provider === 'odorik' ? 'btn-primary' : 'btn-outline'}`}
                                            onClick={() => handleProviderChange('odorik')}
                                        >
                                            📱 Odorik (mobilní)
                                        </button>
                                        <button
                                            type="button"
                                            className={`btn ${provider === 'asterisk' ? 'btn-primary' : 'btn-outline'}`}
                                            onClick={() => handleProviderChange('asterisk')}
                                        >
                                            🛰 Asterisk + Odorik
                                        </button>
                                    </div>
                                </div>
                            )}

                            {!isFbSelected && provider === 'odorik' && (
                                <div className="form-group">
                                    <label className="form-label">Odorik linka</label>
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        {(['mobilni', 'pevna'] as OdorikLine[]).map((line) => {
                                            const lineConfig = odorikConfig?.lines?.[line as 'mobilni' | 'pevna'];
                                            const lineUnavailable = odorikConfig !== null && (lineConfig?.maxWorkers ?? 0) === 0;
                                            return (
                                                <button
                                                    key={line}
                                                    type="button"
                                                    className={`btn ${odorikLine === line ? 'btn-primary' : 'btn-outline'}`}
                                                    onClick={() => setOdorikLine(line)}
                                                    disabled={lineUnavailable}
                                                    title={lineUnavailable ? 'Žádné SIP jméno není aktuálně schváleno pro tuto linku' : undefined}
                                                >
                                                    {ODORIK_LINE_LABELS[line].icon} {ODORIK_LINE_LABELS[line].label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                    {(odorikLine === 'mobilni' || odorikLine === 'pevna') && (
                                        <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 6 }}>
                                            Zákazník uvidí na displeji: <span style={{ fontFamily: 'monospace', color: 'var(--primary)', fontWeight: 700 }}>{ODORIK_LINE_DISPLAY_CLIP[odorikLine]}</span>
                                        </div>
                                    )}
                                    {odorikUnavailable && (
                                        <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }}>
                                            ⚠️ Vybraná Odorik linka momentálně nedostupná — žádné SIP jméno není schváleno.
                                        </div>
                                    )}
                                    <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 6 }}>
                                        ℹ️ Odorik má prodlevu ~1,5s před vytočením (propagace routy) a 10–18s pauzu mezi hovory.
                                    </div>
                                </div>
                            )}

                            {isAsterisk && (
                                <div className="form-group">
                                    <label className="form-label">Volací mód</label>
                                    <div style={{
                                        display: 'inline-flex', alignItems: 'center', gap: 8,
                                        padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                                        background: '#dbeafe', color: '#1d4ed8', border: '1px solid #93c5fd',
                                    }}>
                                        🛰 Rotující — linky na vlastní ústředně se střídají
                                    </div>
                                    <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 8 }}>
                                        Hovory jdou přes vlastní ústřednu (Asterisk) a Odorik, striktně jeden po druhém,
                                        s 10–18s pauzou mezi nimi. Dávku lze zastavit tlačítkem Stop (rozběhnutý hovor doběhne).
                                    </div>
                                </div>
                            )}

                            {isFbSelected && (
                                <div className="form-group">
                                    <label className="form-label">Volací mód</label>
                                    <div style={{
                                        display: 'inline-flex', alignItems: 'center', gap: 8,
                                        padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                                        background: '#ede9fe', color: '#6d28d9', border: '1px solid #c4b5fd',
                                    }}>
                                        🔄 Rotující — {fbIdentityCount || '…'} linek se střídá
                                    </div>
                                    <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 8 }}>
                                        Žádná paralelita — hovory jdou striktně jeden po druhém, s 10–18s pauzou
                                        mezi nimi, a identita (SIP jméno + CLIP) se mění kolo dokola s každým dalším
                                        hovorem. Cíl: rozprostřít zátěž přes všech {fbIdentityCount || 'N'} linek, ne
                                        koncentrovat ji na jednu.
                                    </div>
                                    {fbConfig && fbConfig.identities.length > 0 && (
                                        <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 8 }}>
                                            Rotující čísla ({fbConfig.identities.length}): <span style={{ fontFamily: 'monospace' }}>
                                                {fbConfig.identities.map(i => i.fromNumber.replace('+420', '')).join(', ')}
                                            </span>
                                        </div>
                                    )}
                                    {fbUnavailable && (
                                        <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>
                                            ⚠️ Žádná FB identita momentálně není dostupná — zkontroluj ENV proměnné ODORIK_FB_SIP_NAME_X / ODORIK_FB_CLIP_X.
                                        </div>
                                    )}
                                </div>
                            )}

                            {!sequential && (
                                <div className="form-group">
                                    <label className="form-label">
                                        Počet workerů (paralelní volání)
                                        <span style={{ fontWeight: 400, color: 'var(--gray-400)', marginLeft: 8, fontSize: 12 }}>max {maxWorkersAvailable}</span>
                                    </label>
                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                        {Array.from({ length: maxWorkersAvailable }, (_, i) => i + 1).map(n => (
                                            <button key={n} type="button" className={`btn ${workers === n ? 'btn-primary' : 'btn-outline'}`} style={{ minWidth: 44 }} onClick={() => setWorkers(n)}>
                                                {n}
                                            </button>
                                        ))}
                                        {maxWorkersAvailable === 0 && (
                                            <span style={{ fontSize: 13, color: 'var(--gray-400)', alignSelf: 'center' }}>
                                                {provider === 'odorik' ? 'Načítám Odorik konfiguraci...' : '—'}
                                            </span>
                                        )}
                                    </div>
                                    {workerLabels.length > 0 && (
                                        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--gray-500)' }}>
                                            {workerLabels.slice(0, workers).map((label, i) => (
                                                <span key={label} style={{ marginRight: 10, fontFamily: 'monospace', color: 'var(--primary)' }}>W{i + 1}: {label}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {!isFbSelected && provider === 'twilio' && workers === 1 && (
                                <div className="form-group">
                                    <label className="form-label">Volající číslo</label>
                                    <div style={{ padding: '9px 12px', background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', fontFamily: 'monospace', fontSize: 15, fontWeight: 700, color: 'var(--primary)' }}>
                                        {twilioNumber || '—'}
                                    </div>
                                </div>
                            )}

                            <div className="form-group">
                                <label className="form-label">Dostupné leady ke kontaktování</label>
                                {loadingMeta ? (
                                    <div className="loading-spinner" style={{ padding: '8px 0', justifyContent: 'flex-start' }}><span className="spinner" /> Načítám...</div>
                                ) : (
                                    <div style={{ padding: '9px 12px', background: novyCount > 0 ? 'var(--success-light)' : 'var(--danger-light)', border: `1px solid ${novyCount > 0 ? '#bbf7d0' : '#fecaca'}`, borderRadius: 'var(--radius)', fontWeight: 700, fontSize: 18, color: novyCount > 0 ? 'var(--success)' : 'var(--danger)' }}>
                                        {novyCount.toLocaleString('cs-CZ')} leadů se statusem NOVY
                                    </div>
                                )}
                            </div>

                            <div className="form-group">
                                <label className="form-label">
                                    Počet hovorů v dávce
                                    <span style={{ fontWeight: 400, color: 'var(--gray-400)', marginLeft: 8, fontSize: 12 }}>(max {novyCount.toLocaleString('cs-CZ')})</span>
                                </label>
                                <input type="number" className="form-input" min={1} max={novyCount} value={maxCalls} onChange={(e) => handleMaxCallsChange(Number(e.target.value))} disabled={novyCount === 0 || loadingMeta} />
                                {maxCalls >= novyCount && novyCount > 0 && (
                                    <div style={{ fontSize: 12, color: 'var(--warning)', marginTop: 4 }}>⚠️ Voláš všechny dostupné leady</div>
                                )}
                            </div>

                            {avgDuration && novyCount > 0 && (
                                <div className="alert alert-info">
                                    <div>
                                        <div style={{ fontWeight: 600, marginBottom: 4 }}>
                                            ⏱ Odhadovaný čas: {estimateTime(maxCalls, sequential ? 1 : workers)}
                                            {!sequential && workers > 1 && <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 8, color: 'var(--primary)' }}>({workers}× rychleji)</span>}
                                            {sequential && <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 8, color: 'var(--gray-500)' }}>(sekvenční, rotující)</span>}
                                        </div>
                                        <div style={{ fontSize: 12 }}>
                                            Průměrný hovor: {formatDuration(avgDuration.avgDuration)} + {avgDuration.overhead}s overhead
                                            {avgDuration.sampleSize > 0 && ` · z ${avgDuration.sampleSize} hovorů`}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {novyCount === 0 && !loadingMeta && (
                                <div className="alert alert-danger">❌ Žádné leady se statusem NOVY pro tohoto agenta. Importuj leady nebo zařaď nedovolané zpět.</div>
                            )}

                            <button
                                className="btn btn-primary btn-lg w-full"
                                onClick={() => setStep('reauth')}
                                disabled={novyCount === 0 || loadingMeta || odorikUnavailable || fbUnavailable}
                            >
                                Pokračovat k ověření →
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {step === 'reauth' && (
                <div style={{ maxWidth: 460 }}>
                    <div className="card">
                        <div className="card-header"><span className="card-title">🔐 Potvrzení spuštění</span></div>
                        <div className="card-body">
                            <div className="alert alert-warning mb-16">
                                <div>
                                    {isFbSelected ? (
                                        <>
                                            Poskytovatel: <strong>📘 Odorik — Facebook (7 linek, rotující)</strong><br />
                                            Volací mód: <strong>🔄 Rotující</strong> ({fbIdentityCount} identit se střídá)<br />
                                        </>
                                    ) : (
                                        <>
                                            Poskytovatel: <strong>{provider === 'twilio' ? '☎️ Twilio (pevná linka)' : provider === 'asterisk' ? '🛰 Asterisk + Odorik (vlastní ústředna, rotující)' : `📱 Odorik (${ODORIK_LINE_LABELS[odorikLine].label})`}</strong><br />
                                            {provider === 'odorik' && (odorikLine === 'mobilni' || odorikLine === 'pevna') && (
                                                <>
                                                    Zákazník uvidí: <strong style={{ fontFamily: 'monospace' }}>{ODORIK_LINE_DISPLAY_CLIP[odorikLine]}</strong><br />
                                                </>
                                            )}
                                        </>
                                    )}
                                    Engine: <strong>{ENGINE_LABELS[engine].icon} {ENGINE_LABELS[engine].label}</strong><br />
                                    Agent: <strong>{selectedAgent.name}</strong> — {selectedAgent.description}<br />
                                    Počet hovorů: <strong>{maxCalls.toLocaleString('cs-CZ')}</strong><br />
                                    {!sequential && (
                                        <>Workeři: <strong>{workers}×</strong> <span style={{ fontFamily: 'monospace', fontSize: 12 }}>({workerLabels.slice(0, workers).join(', ')})</span><br /></>
                                    )}
                                    Odhadovaný čas: <strong>{estimateTime(maxCalls, sequential ? 1 : workers)}</strong><br /><br />
                                    Pro potvrzení zadej své heslo.
                                </div>
                            </div>
                            {reauthError && <div className="alert alert-danger mb-16">⚠️ {reauthError}</div>}
                            <form onSubmit={handleReauth}>
                                <div className="form-group">
                                    <label className="form-label">Heslo</label>
                                    <input type="password" className="form-input" placeholder="••••••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus disabled={reauthLoading} />
                                </div>
                                <div style={{ display: 'flex', gap: 10 }}>
                                    <button type="button" className="btn btn-outline" onClick={() => setStep('setup')} disabled={reauthLoading}>← Zpět</button>
                                    <button type="submit" className="btn btn-success btn-lg" style={{ flex: 1 }} disabled={reauthLoading || !password}>
                                        {reauthLoading ? <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Spouštím...</> : `🚀 Spustit ${selectedAgent.name}${!sequential ? ` (${workers} worker${workers > 1 ? 'y' : ''})` : ''}`}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            )}

            {step === 'calling' && batchStatus && (
                <div style={{ maxWidth: 640 }}>
                    <div style={{ background: 'var(--primary-light)', border: '1px solid #bfdbfe', borderRadius: 'var(--radius)', padding: '8px 14px', fontSize: 13, color: 'var(--primary)', fontWeight: 600, marginBottom: 12 }}>
                        🤖 {selectedAgent.name} · {ENGINE_LABELS[engine].icon} {ENGINE_LABELS[engine].label} · {isFbSelected ? '📘 FB rotující' : (provider === 'twilio' ? '☎️ Twilio' : provider === 'asterisk' ? '🛰 Asterisk + Odorik' : `📱 Odorik ${ODORIK_LINE_LABELS[odorikLine].label}`)} · {sequential ? 'sekvenční' : `${workers} worker${workers > 1 ? 'y' : ''}`} · „{displayedPitch.slice(0, 55)}..."
                    </div>
                    <div className="live-feed mb-16">
                        <span className="live-dot" />
                        {batchStatus.isRunning && batchStatus.currentCall ? (
                            <span>Právě volám: <strong>{batchStatus.currentCall.phone}</strong>{batchStatus.currentCall.companyName && <span style={{ color: '#86efac', marginLeft: 8 }}>{batchStatus.currentCall.companyName}</span>}</span>
                        ) : (
                            <span style={{ color: '#fbbf24' }}>⏳ Připravuji další hovor...</span>
                        )}
                    </div>
                    <div className="card mb-16">
                        <div className="card-body">
                            <div className="flex justify-between items-center mb-8">
                                <span style={{ fontWeight: 600 }}>Průběh dávky</span>
                                <span style={{ fontSize: 13, color: 'var(--gray-500)' }}>{batchStatus.today.completed} hovorů dokončeno</span>
                            </div>
                            <div className="progress-wrapper"><div className="progress-bar" style={{ width: `${progressPercent()}%` }} /></div>
                            <div className="flex justify-between items-center mt-8">
                                <span style={{ fontSize: 12, color: 'var(--gray-400)' }}>{progressPercent()}% dokončeno</span>
                                <span style={{ fontSize: 12, color: 'var(--gray-500)', fontWeight: 600 }}>Zbývá: {remainingTime()}</span>
                            </div>
                        </div>
                    </div>
                    <div className="stats-grid mb-16">
                        <div className="stat-card"><div className="stat-label">Celkem hovorů</div><div className="stat-value primary">{batchStatus.today.completed}</div></div>
                        <div className="stat-card"><div className="stat-label">Zájem ✅</div><div className="stat-value success">{batchStatus.today.interested}</div></div>
                        <div className="stat-card"><div className="stat-label">Nezvedl</div><div className="stat-value warning">{batchStatus.today.noAnswer}</div></div>
                        <div className="stat-card"><div className="stat-label">Položil</div><div className="stat-value warning">{batchStatus.today.hungUp}</div></div>
                        <div className="stat-card"><div className="stat-label">Odmítnuto</div><div className="stat-value danger">{batchStatus.today.rejected}</div></div>
                        <div className="stat-card"><div className="stat-label">Konverze</div><div className="stat-value primary">{batchStatus.today.conversionRate}%</div></div>
                        <div className="stat-card"><div className="stat-label">Prům. délka</div><div className="stat-value">{batchStatus.today.avgDuration > 0 ? formatDuration(batchStatus.today.avgDuration) : '—'}</div></div>
                    </div>
                    <div className="alert alert-info">💡 Stránka se automaticky aktualizuje každé 3 sekundy. Nezavírej okno prohlížeče.</div>
                    {isAsterisk && (
                        <div style={{ marginTop: 16 }}>
                            {stopping ? (
                                <div className="alert alert-warning">🛑 Zastavuji… právě rozběhnutý hovor ještě doběhne, pak se dávka ukončí.</div>
                            ) : (
                                <div style={{ display: 'flex', gap: 10 }}>
                                    <button type="button" className={`btn ${stopConfirm ? 'btn-danger' : 'btn-outline'}`} onClick={handleStop}>
                                        {stopConfirm ? '⚠️ Opravdu zastavit? Klikni znovu' : '🛑 Zastavit dávku'}
                                    </button>
                                    {stopConfirm && (
                                        <button type="button" className="btn btn-outline" onClick={() => setStopConfirm(false)}>✕ Zrušit</button>
                                    )}
                                </div>
                            )}
                            {stopError && <div className="alert alert-danger mt-8">⚠️ {stopError}</div>}
                        </div>
                    )}
                </div>
            )}

            {step === 'done' && batchStatus && (
                <div style={{ maxWidth: 640 }}>
                    <div className="alert alert-success mb-24" style={{ fontSize: 16 }}>
                        {stopping ? '🛑 Dávka zastavena.' : '🎉 Dávka dokončena!'} Agent: <strong>{selectedAgent.name}</strong> · Engine: <strong>{ENGINE_LABELS[engine].label}</strong>
                        {startedAt && <span style={{ marginLeft: 8, fontSize: 13, opacity: 0.8 }}>· Spuštěno: {startedAt.toLocaleTimeString('cs-CZ')}</span>}
                    </div>
                    <div className="stats-grid mb-24">
                        <div className="stat-card"><div className="stat-label">Celkem hovorů</div><div className="stat-value primary">{batchStatus.today.completed}</div></div>
                        <div className="stat-card"><div className="stat-label">Zájem ✅</div><div className="stat-value success">{batchStatus.today.interested}</div><div className="stat-sub">CHCE_KONTAKT_AI</div></div>
                        <div className="stat-card"><div className="stat-label">Nezvedl</div><div className="stat-value warning">{batchStatus.today.noAnswer}</div></div>
                        <div className="stat-card"><div className="stat-label">Položil</div><div className="stat-value warning">{batchStatus.today.hungUp}</div></div>
                        <div className="stat-card"><div className="stat-label">Odmítnuto</div><div className="stat-value danger">{batchStatus.today.rejected}</div></div>
                        <div className="stat-card"><div className="stat-label">Odkládá</div><div className="stat-value warning">{batchStatus.today.callback}</div></div>
                        <div className="stat-card"><div className="stat-label">Konverze</div><div className="stat-value primary">{batchStatus.today.conversionRate}%</div><div className="stat-sub">zájem / dokončeno</div></div>
                    </div>
                    <div style={{ display: 'flex', gap: 12 }}>
                        <button className="btn btn-primary btn-lg" onClick={handleReset}>🔄 Spustit novou dávku</button>
                        <a href="/crm/history" className="btn btn-outline btn-lg">📊 Zobrazit historii dávek</a>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Calling;