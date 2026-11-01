import { Router } from 'express';
import authRoutes from './auth.routes';
import usersRoutes from './users.routes';
import leadsRoutes from './leads.routes';
import phoneScreeningRoutes from './phoneScreening.routes';
import invoiceDataRoutes from './invoiceData.routes';
import leadsImportRoutes from './leadsImport.routes';
import aiCallsRoutes from '../aiagent/routes/aiCalls.routes';
import batchCallsRoutes from '../aiagent/routes/batchCalls.routes';
import recordingsRoutes from '../aiagent/routes/recordings.routes';
import alertsRoutes from './alerts.routes';
const router = Router();

// Verze Node.jsS, která opravdu běží (kontrola po bezpečnostních záplatách, viz Render advisory 23.10.2026)
console.log(`🟢 Node.js runtime: ${process.version}`);

router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/leads', leadsRoutes);
router.use('/leads', phoneScreeningRoutes);
router.use('/leads', invoiceDataRoutes);
router.use('/leads', leadsImportRoutes);
router.use('/ai-calls', aiCallsRoutes);
router.use('/ai-calls', batchCallsRoutes);
// Veřejné přehrávání nahrávek (Asterisk) – záměrně mimo /ai-calls, tam je authenticate na celém routeru
router.use('/recordings', recordingsRoutes);
router.use('/alerts', alertsRoutes);

router.get('/health', (_req, res) => {
    res.status(200).json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        service: 'Quantum CRM Backend',
        version: '1.0.0',
    });
});

export default router;