import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

interface LayoutProps {
    children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();

    const handleLogout = async () => {
        await logout();
        navigate('/crm/login');
    };

    const navItems = [
        { path: '/crm/dashboard', label: 'Dashboard', icon: '📋' },
        { path: '/crm/calling', label: 'AI Volání', icon: '📞' },
        { path: '/crm/unanswered', label: 'Nedovolané', icon: '🔁' },
        { path: '/crm/import', label: 'Import leadů', icon: '⬆' },
        { path: '/crm/history', label: 'Historie dávek', icon: '📊' },
    ];

    return (
        <div className="app-layout">
            <aside className="sidebar">
                <div className="sidebar-logo">
                    <h1>Quantum CRM</h1>
                    <span>AI Calling System</span>
                </div>

                <nav className="sidebar-nav">
                    {navItems.map((item) => (
                        <button
                            key={item.path}
                            className={`nav-item ${location.pathname === item.path ? 'active' : ''}`}
                            onClick={() => navigate(item.path)}
                        >
                            <span className="nav-icon">{item.icon}</span>
                            {item.label}
                        </button>
                    ))}
                </nav>

                <div className="sidebar-footer">
                    <div className="sidebar-user">
                        👤 {user?.fullName || user?.email}
                    </div>
                    <button className="btn btn-outline w-full btn-sm" onClick={handleLogout}>
                        Odhlásit se
                    </button>
                </div>
            </aside>

            <main className="main-content">
                {children}
            </main>
        </div>
    );
};

export default Layout;