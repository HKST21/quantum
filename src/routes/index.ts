import { Router } from 'express';
import authRoutes from './auth.routes';
import usersRoutes from './users.routes';
import leadsRoutes from './leads.routes';
import phoneScreeningRoutes from './phoneScreening.routes';
import invoiceDataRoutes from './invoiceData.routes';
import leadsImportRoutes from './leadsImport.routes';
import aiCallsRoutes from '../aiagent/routes/aiCalls.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/leads', leadsRoutes);
router.use('/leads', phoneScreeningRoutes);
router.use('/leads', invoiceDataRoutes);
router.use('/leads', leadsImportRoutes);
router.use('/ai-calls', aiCallsRoutes);

router.get('/health', (_req, res) => {
    res.status(200).json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        service: 'Quantum CRM Backend',
        version: '1.0.0',
    });
});

export default router;