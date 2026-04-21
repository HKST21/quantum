import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import http from 'http';
import { WebSocketServer } from 'ws';
import pool, { testConnection } from './db/pool';
import routes from './routes';
import { AppError } from './utils/errors';
import { callHandler } from './aiagent/websockets/callHandler';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

// ============================================
// WEBSOCKET SERVER
// ============================================

const wss = new WebSocketServer({
    server,
    path: '/api/ai-calls/websocket',
});

wss.on('connection', (ws, _req) => {
    console.log('🔌 New WebSocket connection');

    let callSid: string | null = null;
    let isInitialized = false;

    ws.on('message', async (message: Buffer) => {
        try {
            const data = JSON.parse(message.toString());

            if (data.event === 'start' && !isInitialized) {
                isInitialized = true;

                callSid = data.start?.customParameters?.callSid || null;
                const streamSid = data.start?.streamSid || null;

                console.log('📞 WebSocket stream started:', { streamSid, callSid });

                if (!callSid || !streamSid) {
                    console.error('❌ Missing callSid or streamSid');
                    ws.close();
                    return;
                }

                try {
                    const result = await pool.query(
                        `SELECT l.id, l.company_name, l.contact_person, l.phone
                         FROM leads l
                         INNER JOIN ai_call_logs acl ON l.id = acl.lead_id
                         WHERE acl.call_sid = $1`,
                        [callSid]
                    );

                    if (result.rows.length === 0) {
                        console.error('❌ Lead not found for call:', callSid);
                        ws.close();
                        return;
                    }

                    const lead = result.rows[0];

                    console.log('✅ Lead loaded:', { id: lead.id, company: lead.company_name });

                    await callHandler.handleConnection(
                        ws,
                        callSid,
                        lead.id,
                        {
                            companyName: lead.company_name,
                            contactPerson: lead.contact_person,
                            phone: lead.phone,
                        },
                        streamSid
                    );
                } catch (error) {
                    console.error('❌ Failed to load call data:', error);
                    ws.close();
                }
            }
        } catch (error) {
            console.error('❌ WebSocket message error:', error);
        }
    });

    ws.on('close', () => console.log('🔌 WebSocket disconnected:', callSid || 'unknown'));
    ws.on('error', (error) => console.error('❌ WebSocket error:', error));
});

console.log('✅ WebSocket server initialized on: /api/ai-calls/websocket');

// ============================================
// TRUST PROXY
// ============================================

app.set('trust proxy', 1);

// ============================================
// SECURITY MIDDLEWARE
// ============================================

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:'],
        },
    },
}));

app.use(cors({
    origin: [
        'http://localhost:3000',
        process.env.FRONTEND_URL || 'http://localhost:3000',
    ],
    credentials: true,
}));

// ============================================
// RATE LIMITING
// ============================================

app.use('/api/', rateLimit({
    windowMs: 900000,
    max: 100,
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
}));

app.use('/api/auth/login', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many login attempts, please try again later.',
    skipSuccessfulRequests: true,
}));

// ============================================
// BODY PARSING
// ============================================

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================
// SESSION
// ============================================

const PgSession = pgSession(session);
const isProduction = process.env.NODE_ENV === 'production';

app.use(session({
    store: new PgSession({
        pool,
        tableName: 'sessions',
        createTableIfMissing: false,
    }),
    secret: process.env.SESSION_SECRET || 'change-this-in-production',
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
        secure: isProduction,
        httpOnly: true,
        maxAge: 8 * 60 * 60 * 1000,
        sameSite: isProduction ? 'none' : 'lax',
        domain: isProduction ? undefined : 'localhost',
    },
    name: 'quantum_crm_session',
}));

// ============================================
// ROUTES
// ============================================

app.use('/api', routes);

app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
        message: 'Quantum CRM Backend API',
        version: '1.0.0',
        status: 'running',
        endpoints: {
            health: '/api/health',
            auth: '/api/auth/*',
            users: '/api/users/*',
            leads: '/api/leads/*',
            aiCalls: '/api/ai-calls/*',
            websocket: 'ws://[host]/api/ai-calls/websocket',
        },
    });
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((_req: Request, _res: Response, next: NextFunction) => {
    next(new AppError(404, 'Route not found'));
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('❌ Error:', err);

    if (err.isOperational) {
        return res.status(err.statusCode).json({
            error: { message: err.message, statusCode: err.statusCode },
        });
    }

    if (err.code === '23505') {
        return res.status(409).json({ error: { message: 'Resource already exists', statusCode: 409 } });
    }

    if (err.code === '23503') {
        return res.status(400).json({ error: { message: 'Invalid reference', statusCode: 400 } });
    }

    return res.status(500).json({
        error: {
            message: isProduction ? 'Internal server error' : err.message,
            statusCode: 500,
        },
    });
});

// ============================================
// START SERVER
// ============================================

const startServer = async () => {
    try {
        console.log('🔍 Testing database connection...');
        const dbConnected = await testConnection();

        if (!dbConnected) {
            console.error('❌ Failed to connect to database. Exiting...');
            process.exit(1);
        }

        server.listen(PORT, () => {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('✅ Quantum CRM Backend Started');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`🚀 Port: ${PORT}`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🔌 WebSocket: ws://localhost:${PORT}/api/ai-calls/websocket`);
            console.log(`🤖 AI Calling: /api/ai-calls/*`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
};

process.on('uncaughtException', (error) => {
    console.error('❌ UNCAUGHT EXCEPTION:', error);
    process.exit(1);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ UNHANDLED REJECTION:', error);
    process.exit(1);
});

process.on('SIGTERM', () => {
    server.close(() => { console.log('✅ Server closed'); process.exit(0); });
});

process.on('SIGINT', () => {
    server.close(() => { console.log('✅ Server closed'); process.exit(0); });
});

startServer();