import React, { useState, useRef } from 'react';

interface ImportSummary {
    total: number;
    inserted: number;
    duplicates: number;
    invalid: number;
}

// ⚠️ NOVÉ (24.9.2026) — seznam agentů pro výběr cílového přiřazení
// importu. Stejný vzor jako AGENTS pole v Dashboard.tsx/Calling.tsx
// (zatím se v kódu nesdílí jeden společný zdroj — potenciální budoucí
// úklid, ale zachovávám konzistenci se stávajícím stylem projektu).
// Výchozí hodnota (AGENTS[0]) = Eva V1 = stejné UUID jako
// DEFAULT_AI_AGENT_ID na backendu, takže default chování zůstává
// 1:1 stejné jako dřív, pokud uživatel dropdown nezmění.
interface AgentOption {
    id: string;
    name: string;
    description: string;
}

const AGENTS: AgentOption[] = [
    { id: '53c65ca7-68bc-4948-83e5-35a64c17f0fb', name: 'Eva V1', description: 'VIP ceník do SMS' },
    { id: 'aeec78ff-a86b-4cab-b33a-adeb7c94f08e', name: 'Eva V2', description: 'Šetříme klientům až 40%' },
    { id: 'e7a469bb-4783-4f96-b961-03dd503e5bfa', name: 'Eva V3', description: 'Nepřeplácíte za služby?' },
    { id: 'f4adb349-70c3-4e63-8670-81f6c177f61d', name: 'Eva V4', description: 'Zjednodušený VIP ceník (krátký pitch)' },
    { id: 'ffbabfc8-08e0-4dae-8a02-f9d7865f2bd9', name: 'Eva V5', description: 'Dvoustupňová kvalifikace' },
    { id: 'dab796fa-bf16-4f99-812c-601a031049ce', name: 'Eva Gemini V2', description: 'Zjednodušený VIP ceník (Gemini)' },
    { id: '99142508-1483-4ea2-ba9f-c35a9ecdc69f', name: 'Eva FB V6', description: 'Facebook leady — skript 1' },
    { id: '773db522-8df4-4903-9b4f-019b8b0969b5', name: 'Eva FB V7', description: 'Facebook leady — skript 2' },
    { id: 'a2a7c4f6-1b90-4b64-8899-451dca563c96', name: 'Eva FB V8', description: 'Facebook leady — skript 3' },
    { id: '3aa4d37f-ebd7-49f9-a72f-c04ac33c057d', name: 'Eva FB V9', description: 'Facebook leady — skript 4' },
];

const Import: React.FC = () => {
    const [file, setFile] = useState<File | null>(null);
    const [agentId, setAgentId] = useState<string>(AGENTS[0].id); // ← NOVÉ, default = Eva V1 (beze změny chování)
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<{ success: boolean; summary: ImportSummary; invalidNumbers: string[] } | null>(null);
    const [error, setError] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0] || null;
        setFile(f);
        setResult(null);
        setError('');
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0] || null;
        if (f && f.name.endsWith('.xlsx')) {
            setFile(f);
            setResult(null);
            setError('');
        } else {
            setError('Pouze .xlsx soubory jsou povoleny');
        }
    };

    const handleImport = async () => {
        if (!file) return;
        setLoading(true);
        setError('');
        setResult(null);

        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('agentUserId', agentId); // ← NOVÉ — dřív se neposílalo vůbec

            const res = await fetch('/api/ai-calls/import-leads', {
                method: 'POST',
                credentials: 'include',
                body: formData,
            });

            const data = await res.json();

            if (!res.ok) {
                setError(data.error?.message || 'Chyba při importu');
                return;
            }

            setResult(data);
        } catch (err: any) {
            setError(err.message || 'Chyba při importu');
        } finally {
            setLoading(false);
        }
    };

    const handleReset = () => {
        setFile(null);
        setResult(null);
        setError('');
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const selectedAgentName = AGENTS.find(a => a.id === agentId)?.name || 'vybranému agentovi';

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Import leadů</h1>
                    <p className="page-subtitle">Nahraj .xlsx soubor s telefonními čísly v prvním sloupci</p>
                </div>
            </div>

            <div style={{ maxWidth: 600 }}>

                {/* INFO */}
                <div className="alert alert-info mb-16">
                    <div>
                        <strong>Formát souboru:</strong>
                        <ul style={{ marginTop: 6, paddingLeft: 20, lineHeight: 1.8 }}>
                            <li>První sloupec = telefonní čísla</li>
                            <li>Podporované formáty: <code>605524894</code>, <code>+420605524894</code>, <code>420605524894</code></li>
                            <li>Header řádek se automaticky přeskočí</li>
                            <li>Duplicitní čísla se přeskočí (kontrola přes celou DB)</li>
                            <li>Leady budou přiřazeny vybranému AI agentovi se statusem NOVY</li>
                        </ul>
                    </div>
                </div>

                {/* UPLOAD ZONE */}
                {!result && (
                    <div className="card mb-16">
                        <div className="card-body">

                            {/* ⚠️ NOVÉ — výběr cílového agenta, PŘED drag&drop zónou */}
                            <div className="form-group">
                                <label className="form-label">Cílový AI agent</label>
                                <select
                                    className="form-select"
                                    value={agentId}
                                    onChange={(e) => setAgentId(e.target.value)}
                                >
                                    {AGENTS.map(agent => (
                                        <option key={agent.id} value={agent.id}>
                                            {agent.name} — {agent.description}
                                        </option>
                                    ))}
                                </select>
                                <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 6 }}>
                                    Všechny naimportované leady se přiřadí tomuto agentovi.
                                </div>
                            </div>

                            {/* Drag & Drop zóna */}
                            <div
                                onDrop={handleDrop}
                                onDragOver={(e) => e.preventDefault()}
                                onClick={() => fileInputRef.current?.click()}
                                style={{
                                    border: `2px dashed ${file ? 'var(--success)' : 'var(--gray-300)'}`,
                                    borderRadius: 'var(--radius-lg)',
                                    padding: '32px 24px',
                                    textAlign: 'center',
                                    cursor: 'pointer',
                                    background: file ? 'var(--success-light)' : 'var(--gray-50)',
                                    transition: 'all 0.2s',
                                    marginBottom: 16,
                                }}
                            >
                                <div style={{ fontSize: 36, marginBottom: 8 }}>
                                    {file ? '✅' : '📂'}
                                </div>
                                {file ? (
                                    <>
                                        <div style={{ fontWeight: 600, color: 'var(--success)', fontSize: 15 }}>
                                            {file.name}
                                        </div>
                                        <div style={{ fontSize: 12, color: 'var(--gray-400)', marginTop: 4 }}>
                                            {(file.size / 1024).toFixed(1)} KB · klikni pro změnu
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div style={{ fontWeight: 600, color: 'var(--gray-600)', fontSize: 15 }}>
                                            Přetáhni soubor sem nebo klikni pro výběr
                                        </div>
                                        <div style={{ fontSize: 12, color: 'var(--gray-400)', marginTop: 4 }}>
                                            Pouze .xlsx soubory · max 50 MB
                                        </div>
                                    </>
                                )}
                            </div>

                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".xlsx,.xls"
                                onChange={handleFileChange}
                                style={{ display: 'none' }}
                            />

                            {error && (
                                <div className="alert alert-danger mb-16">⚠️ {error}</div>
                            )}

                            <div style={{ display: 'flex', gap: 10 }}>
                                <button
                                    className="btn btn-primary btn-lg"
                                    style={{ flex: 1 }}
                                    onClick={handleImport}
                                    disabled={!file || loading}
                                >
                                    {loading ? (
                                        <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Importuji...</>
                                    ) : (
                                        '⬆ Spustit import'
                                    )}
                                </button>
                                {file && (
                                    <button className="btn btn-outline" onClick={handleReset}>
                                        ✕ Zrušit
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* VÝSLEDEK */}
                {result && (
                    <div className="card">
                        <div className="card-header">
                            <span className="card-title">✅ Import dokončen</span>
                        </div>
                        <div className="card-body">
                            <div className="stats-grid mb-16">
                                <div className="stat-card">
                                    <div className="stat-label">Celkem čísel</div>
                                    <div className="stat-value primary">{result.summary.total.toLocaleString('cs-CZ')}</div>
                                </div>
                                <div className="stat-card">
                                    <div className="stat-label">Importováno</div>
                                    <div className="stat-value success">{result.summary.inserted.toLocaleString('cs-CZ')}</div>
                                    <div className="stat-sub">nových leadů</div>
                                </div>
                                <div className="stat-card">
                                    <div className="stat-label">Duplicity</div>
                                    <div className="stat-value warning">{result.summary.duplicates.toLocaleString('cs-CZ')}</div>
                                    <div className="stat-sub">přeskočeno</div>
                                </div>
                                <div className="stat-card">
                                    <div className="stat-label">Neplatná čísla</div>
                                    <div className="stat-value danger">{result.summary.invalid.toLocaleString('cs-CZ')}</div>
                                    <div className="stat-sub">přeskočeno</div>
                                </div>
                            </div>

                            {result.summary.inserted > 0 && (
                                <div className="alert alert-success mb-16">
                                    🎉 Úspěšně importováno <strong>{result.summary.inserted.toLocaleString('cs-CZ')} čísel</strong> jako NOVY leady přiřazené agentovi <strong>{selectedAgentName}</strong>.
                                </div>
                            )}

                            {result.invalidNumbers && result.invalidNumbers.length > 0 && (
                                <div className="alert alert-warning mb-16">
                                    <strong>Neplatná čísla ({result.invalidNumbers.length}):</strong>
                                    <div style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 6, lineHeight: 1.8 }}>
                                        {result.invalidNumbers.join(', ')}
                                    </div>
                                </div>
                            )}

                            <div style={{ display: 'flex', gap: 10 }}>
                                <button className="btn btn-primary" onClick={handleReset}>
                                    ⬆ Importovat další soubor
                                </button>
                                <a href="/crm/calling" className="btn btn-success">
                                    📞 Jít na volání
                                </a>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default Import;