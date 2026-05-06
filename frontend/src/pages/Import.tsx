import React, { useState, useRef } from 'react';

interface ImportSummary {
    total: number;
    inserted: number;
    duplicates: number;
    invalid: number;
}

const Import: React.FC = () => {
    const [file, setFile] = useState<File | null>(null);
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
                            <li>Leady budou přiřazeny Evě (AI Agent) se statusem NOVY</li>
                        </ul>
                    </div>
                </div>

                {/* UPLOAD ZONE */}
                {!result && (
                    <div className="card mb-16">
                        <div className="card-body">
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
                                    🎉 Úspěšně importováno <strong>{result.summary.inserted.toLocaleString('cs-CZ')} čísel</strong> jako NOVY leady přiřazené Evě.
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