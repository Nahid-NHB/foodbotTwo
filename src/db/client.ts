import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'pg pool error');
});

export type QueryParams = ReadonlyArray<unknown>;

async function _query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: QueryParams,
): Promise<T[]> {
  const result = await pool.query<T>(text, params as unknown[]);
  return result.rows;
}

async function _withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function _close(): Promise<void> {
  await pool.end();
}

/**
 * Default export is the only way to safely share DB helpers across modules
 * in Vite/Vitest without hitting "query2 is not a function" module-graph
 * collisions on named re-exports.
 */
export default {
  query: _query,
  withTransaction: _withTransaction,
  close: _close,
  pool,
};

// Also export individually for direct callers
export const query = _query;
export const closeDb = _close;
export const withTransaction = _withTransaction;