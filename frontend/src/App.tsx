import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Calling from './pages/Calling';
import BatchHistory from './pages/BatchHistory';
import BatchDetail from './pages/BatchDetail';
import Unanswered from './pages/Unanswered';
import Import from './pages/Import';
import Layout from './components/Layout';
import { AuthProvider, useAuth } from './context/AuthContext';
import './styles/global.css';

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { isAuthenticated } = useAuth();
    if (!isAuthenticated) return <Navigate to="/crm/login" replace />;
    return <>{children}</>;
};

const App: React.FC = () => {
    return (
        <AuthProvider>
            <BrowserRouter>
                <Routes>
                    <Route path="/crm/login" element={<Login />} />
                    <Route
                        path="/crm/*"
                        element={
                            <ProtectedRoute>
                                <Layout>
                                    <Routes>
                                        <Route path="dashboard" element={<Dashboard />} />
                                        <Route path="calling" element={<Calling />} />
                                        <Route path="history" element={<BatchHistory />} />
                                        <Route path="history/:date" element={<BatchDetail />} />
                                        <Route path="unanswered" element={<Unanswered />} />
                                        <Route path="import" element={<Import />} />
                                        <Route path="*" element={<Navigate to="/crm/dashboard" replace />} />
                                    </Routes>
                                </Layout>
                            </ProtectedRoute>
                        }
                    />
                    <Route path="*" element={<Navigate to="/crm/login" replace />} />
                </Routes>
            </BrowserRouter>
        </AuthProvider>
    );
};

export default App;