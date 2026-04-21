import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const poolConfig: PoolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : undefined,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
};

const pool = new Pool(poolConfig);

pool.on('connect', (_client) => {
    console.log('✅ New PostgreSQL client connected');
});

pool.on('error', (err, _client) => {
    console.error('❌ Unexpected PostgreSQL error:', err);
    process.exit(-1);
});

export const testConnection = async (): Promise<boolean> => {
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT NOW()');
        client.release();
        console.log('✅ Database connection successful:', result.rows[0].now);
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error);
        return false;
    }
};

export const toCamelCase = (str: string): string => {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
};

export const toSnakeCase = (str: string): string => {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
};

export const rowToCamelCase = <T>(row: any): T => {
    if (!row) return row;
    const result: any = {};
    for (const key in row) {
        result[toCamelCase(key)] = row[key];
    }
    return result as T;
};

export const rowsToCamelCase = <T>(rows: any[]): T[] => {
    return rows.map((row) => rowToCamelCase<T>(row));
};

export default pool;