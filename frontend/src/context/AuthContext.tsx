import React, { createContext, useContext, useState, useEffect } from 'react';

const API_BASE = '/api';

interface User {
    id: string;
    email: string;
    fullName: string;
    role: string;
}

interface AuthContextType {
    isAuthenticated: boolean;
    user: User | null;
    loading: boolean;
    login: (email: string, password: string) => Promise<void>;
    verifyTwoFactor: (email: string, token: string) => Promise<void>;
    logout: () => Promise<void>;
    pendingEmail: string | null;
}

const AuthContext = createContext<AuthContextType | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [pendingEmail, setPendingEmail] = useState<string | null>(null);

    // Zkontroluj session při načtení
    useEffect(() => {
        const checkSession = async () => {
            try {
                const res = await fetch(`${API_BASE}/auth/me`, {
                    credentials: 'include',
                });
                if (res.ok) {
                    const data = await res.json();
                    setUser(data.user);
                    setIsAuthenticated(true);
                }
            } catch {
                // session neexistuje
            } finally {
                setLoading(false);
            }
        };
        checkSession();
    }, []);

    const login = async (email: string, password: string): Promise<void> => {
        const res = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error?.message || 'Chyba přihlášení');
        }

        // Backend vrátí requiresTwoFactor: true
        setPendingEmail(email);
    };

    const verifyTwoFactor = async (email: string, token: string): Promise<void> => {
        const res = await fetch(`${API_BASE}/auth/verify-2fa`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, token }),
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error?.message || 'Neplatný kód');
        }

        setUser(data.user);
        setIsAuthenticated(true);
        setPendingEmail(null);
    };

    const logout = async (): Promise<void> => {
        await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            credentials: 'include',
        });
        setUser(null);
        setIsAuthenticated(false);
        setPendingEmail(null);
    };

    return (
        <AuthContext.Provider value={{
            isAuthenticated,
            user,
            loading,
            login,
            verifyTwoFactor,
            logout,
            pendingEmail,
        }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = (): AuthContextType => {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within AuthProvider');
    return ctx;
};