import React, { useEffect, useRef, useState } from 'react';

const API_BASE = '/api';
const POLLING_INTERVAL_MS = 10_000;

interface Alert {
    id: string;
    type: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    metadata: Record<string, any>;
    created_at: string;
}

interface UnresolvedResponse {
    success: boolean;
    alerts: Alert[];
    count: number;
}

/**
 * Notification Bell - zobrazuje se vpravo nahoře v Layoutu.
 *
 * Chování:
 * - Polling každých 10s na /api/alerts/unresolved
 * - Když alerts.length > 0 → červená ikona s badge (počet)
 * - Klik → dropdown se seznamem alertů
 * - Každý alert má tlačítko "OK" (resolve) → skryje se
 * - Tlačítko "Označit vše jako vyřešené" v patičce dropdownu
 * - Když nejsou žádné alerty → šedá ikona bez badge
 */
const NotificationBell: React.FC = () => {
    const [alerts, setAlerts] = useState<Alert[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const bellRef = useRef<HTMLButtonElement>(null);

    // Polling neresolved alerts
    useEffect(() => {
        const fetchAlerts = async () => {
            try {
                const res = await fetch(`${API_BASE}/alerts/unresolved`, {
                    credentials: 'include',
                });
                if (!res.ok) return;
                const data: UnresolvedResponse = await res.json();
                if (data.success) {
                    setAlerts(data.alerts || []);
                }
            } catch {
                // silent - polling nevadí když občas selže
            }
        };

        fetchAlerts(); // initial fetch
        const interval = setInterval(fetchAlerts, POLLING_INTERVAL_MS);
        return () => clearInterval(interval);
    }, []);

    // Zavírání dropdownu při kliknutí mimo
    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (
                dropdownRef.current &&
                bellRef.current &&
                !dropdownRef.current.contains(e.target as Node) &&
                !bellRef.current.contains(e.target as Node)
            ) {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    const resolveAlert = async (id: string) => {
        try {
            const res = await fetch(`${API_BASE}/alerts/${id}/resolve`, {
                method: 'POST',
                credentials: 'include',
            });
            if (res.ok) {
                setAlerts((prev) => prev.filter((a) => a.id !== id));
            }
        } catch {
            // silent
        }
    };

    const resolveAll = async () => {
        try {
            const res = await fetch(`${API_BASE}/alerts/resolve-all`, {
                method: 'POST',
                credentials: 'include',
            });
            if (res.ok) {
                setAlerts([]);
                setIsOpen(false);
            }
        } catch {
            // silent
        }
    };

    const hasAlerts = alerts.length > 0;
    const count = alerts.length;

    // Formátování času "před X min"
    const formatTimeAgo = (isoDate: string): string => {
        const date = new Date(isoDate);
        const diffMs = Date.now() - date.getTime();
        const diffMin = Math.floor(diffMs / 60_000);
        if (diffMin < 1) return 'právě teď';
        if (diffMin < 60) return `před ${diffMin} min`;
        const diffHours = Math.floor(diffMin / 60);
        if (diffHours < 24) return `před ${diffHours} h`;
        const diffDays = Math.floor(diffHours / 24);
        return `před ${diffDays} d`;
    };

    return (
        <div className="notification-bell-wrapper">
            <button
                ref={bellRef}
                className={`notification-bell ${hasAlerts ? 'has-alerts' : ''}`}
                onClick={() => setIsOpen(!isOpen)}
                title={hasAlerts ? `${count} neošetřených alertů` : 'Žádné alerty'}
                aria-label="Notifikace"
            >
                <span className="bell-icon">🔔</span>
                {hasAlerts && <span className="bell-badge">{count > 99 ? '99+' : count}</span>}
            </button>

            {isOpen && (
                <div ref={dropdownRef} className="notification-dropdown">
                    <div className="notification-dropdown-header">
                        <strong>Alerty ({count})</strong>
                        {hasAlerts && (
                            <button
                                className="notification-resolve-all"
                                onClick={resolveAll}
                                title="Označit vše jako vyřešené"
                            >
                                Vše OK
                            </button>
                        )}
                    </div>

                    <div className="notification-dropdown-list">
                        {alerts.length === 0 ? (
                            <div className="notification-empty">
                                <span style={{ fontSize: 32, opacity: 0.5 }}>✓</span>
                                <div style={{ marginTop: 8 }}>Žádné alerty</div>
                            </div>
                        ) : (
                            alerts.map((alert) => (
                                <div
                                    key={alert.id}
                                    className={`notification-item severity-${alert.severity}`}
                                >
                                    <div className="notification-item-header">
                                        <span className="notification-item-type">{alert.type}</span>
                                        <span className="notification-item-time">
                                            {formatTimeAgo(alert.created_at)}
                                        </span>
                                    </div>
                                    <div className="notification-item-message">{alert.message}</div>
                                    <button
                                        className="notification-item-resolve"
                                        onClick={() => resolveAlert(alert.id)}
                                    >
                                        OK
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default NotificationBell;