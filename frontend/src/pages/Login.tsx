import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const Login: React.FC = () => {
    const { login, verifyTwoFactor, pendingEmail } = useAuth();
    const navigate = useNavigate();

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [token, setToken] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            await login(email, password);
        } catch (err: any) {
            setError(err.message || 'Chyba přihlášení');
        } finally {
            setLoading(false);
        }
    };

    const handleVerify = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            await verifyTwoFactor(pendingEmail!, token);
            navigate('/crm/dashboard');
        } catch (err: any) {
            setError(err.message || 'Neplatný kód');
            setToken('');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-page">
            <div className="login-card">
                <div className="login-logo">
                    <h1>Quantum CRM</h1>
                    <p>AI Calling System — Cante Trading</p>
                </div>

                {!pendingEmail ? (
                    // KROK 1 — Email + heslo
                    <form onSubmit={handleLogin}>
                        <p className="login-title">Přihlášení</p>
                        <p className="login-subtitle">Zadejte své přihlašovací údaje</p>

                        {error && (
                            <div className="alert alert-danger mb-16">
                                ⚠️ {error}
                            </div>
                        )}

                        <div className="form-group">
                            <label className="form-label">Email</label>
                            <input
                                type="email"
                                className="form-input"
                                placeholder="vas@email.cz"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                autoFocus
                                disabled={loading}
                            />
                        </div>

                        <div className="form-group">
                            <label className="form-label">Heslo</label>
                            <input
                                type="password"
                                className="form-input"
                                placeholder="••••••••••••"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                disabled={loading}
                            />
                        </div>

                        <button
                            type="submit"
                            className="btn btn-primary w-full btn-lg"
                            disabled={loading}
                        >
                            {loading ? (
                                <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Přihlašování...</>
                            ) : (
                                '→ Přihlásit se'
                            )}
                        </button>
                    </form>
                ) : (
                    // KROK 2 — Google Authenticator TOTP
                    <form onSubmit={handleVerify}>
                        <p className="login-title">Dvoufaktorové ověření</p>
                        <p className="login-subtitle">
                            Zadejte 6místný kód z aplikace Google Authenticator
                        </p>

                        {error && (
                            <div className="alert alert-danger mb-16">
                                ⚠️ {error}
                            </div>
                        )}

                        <div className="form-group">
                            <label className="form-label">Ověřovací kód</label>
                            <input
                                type="text"
                                className="form-input"
                                placeholder="123456"
                                value={token}
                                onChange={(e) => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                required
                                autoFocus
                                maxLength={6}
                                disabled={loading}
                                style={{ fontSize: 24, letterSpacing: 8, textAlign: 'center' }}
                            />
                        </div>

                        <button
                            type="submit"
                            className="btn btn-primary w-full btn-lg"
                            disabled={loading || token.length !== 6}
                        >
                            {loading ? (
                                <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Ověřování...</>
                            ) : (
                                '✓ Ověřit kód'
                            )}
                        </button>

                        <button
                            type="button"
                            className="btn btn-outline w-full mt-8"
                            onClick={() => {
                                setError('');
                                setToken('');
                                window.location.reload();
                            }}
                            disabled={loading}
                        >
                            ← Zpět
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
};

export default Login;