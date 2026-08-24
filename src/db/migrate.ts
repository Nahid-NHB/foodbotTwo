import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, closeDb } from './client.js';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

export async function migrate(): Promise<void> {
  // Ensure _migrations exists (in case 001_init hasn't run yet).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows: applied } = await pool.query<{ filename: string }>('SELECT filename FROM _migrations');
  const appliedSet = new Set(applied.map((r) => r.filename));

  for (const filename of files) {
    if (appliedSet.has(filename)) {
      logger.info({ filename }, 'migration already applied');
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    logger.info({ filename }, 'applying migration');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      logger.info({ filename }, 'migration applied');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, filename }, 'migration failed');
      throw err;
    } finally {
      client.release();
    }
  }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  migrate()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.fatal({ err }, 'migrate failed');
      process.exit(1);
    });
}
