import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export interface AppDatabase {
  readonly enabled: boolean;
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

class DisabledDatabase implements AppDatabase {
  readonly enabled = false;

  async query(): Promise<{ rows: never[] }> {
    throw new Error('PostgreSQL 未配置，请设置 DATABASE_URL');
  }

  async transaction<T>(): Promise<T> {
    throw new Error('PostgreSQL 未配置，请设置 DATABASE_URL');
  }

  async migrate() {}
  async close() {}
}

class PostgresDatabase implements AppDatabase {
  readonly enabled = true;
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: Math.max(2, Number(process.env.DB_POOL_MAX || 10)),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async migrate() {
    // 多个后端实例可能同时启动；事务级 advisory lock 保证字段迁移不会
    // 在 DROP/ADD 主键约束之间互相竞争。
    await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [734921508]);
      await client.query(`
      CREATE TABLE IF NOT EXISTS auth_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        salt TEXT NOT NULL,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_settings (
        workspace_id TEXT NOT NULL DEFAULT 'admin',
        id SMALLINT NOT NULL CHECK (id = 1),
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id)
      );
      CREATE TABLE IF NOT EXISTS automation_tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'admin',
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'admin',
        payload JSONB NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS automation_runs_finished_at_idx ON automation_runs (finished_at DESC);
      CREATE TABLE IF NOT EXISTS shipments (
        workspace_id TEXT NOT NULL DEFAULT 'admin',
        source_row INTEGER PRIMARY KEY,
        carrier_hint TEXT NOT NULL DEFAULT '',
        bill_no TEXT NOT NULL,
        container_no TEXT NOT NULL DEFAULT '',
        arrival_time TEXT,
        discharge_time TEXT,
        vessel_state TEXT NOT NULL DEFAULT '',
        manual_mark TEXT NOT NULL DEFAULT '',
        last_updated TIMESTAMPTZ,
        note TEXT NOT NULL DEFAULT '',
        progress TEXT NOT NULL DEFAULT '',
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS shipments_bill_no_idx ON shipments (bill_no);
      CREATE INDEX IF NOT EXISTS shipments_container_no_idx ON shipments (container_no);

      -- Older installations predate workspace isolation.  Existing rows are
      -- intentionally assigned to the administrator's workspace so no data
      -- disappears during the upgrade.  The statements are idempotent and
      -- can safely run on every application start.
      ALTER TABLE automation_settings ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'admin';
      ALTER TABLE automation_tasks ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'admin';
      ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'admin';
      ALTER TABLE shipments ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'admin';

      ALTER TABLE automation_settings DROP CONSTRAINT IF EXISTS automation_settings_pkey;
      ALTER TABLE automation_settings DROP CONSTRAINT IF EXISTS automation_settings_workspace_pkey;
      ALTER TABLE automation_settings ADD CONSTRAINT automation_settings_workspace_pkey PRIMARY KEY (workspace_id, id);

      ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_pkey;
      ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_workspace_pkey;
      ALTER TABLE shipments ADD CONSTRAINT shipments_workspace_pkey PRIMARY KEY (workspace_id, source_row);

      CREATE INDEX IF NOT EXISTS automation_tasks_workspace_created_idx ON automation_tasks (workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS automation_runs_workspace_finished_idx ON automation_runs (workspace_id, finished_at DESC);
      CREATE INDEX IF NOT EXISTS shipments_workspace_bill_no_idx ON shipments (workspace_id, bill_no);
      CREATE INDEX IF NOT EXISTS shipments_workspace_container_no_idx ON shipments (workspace_id, container_no);
      `);
    });
  }

  async close() {
    await this.pool.end();
  }
}

export function createAppDatabase() {
  const connectionString = process.env.DATABASE_URL?.trim();
  return connectionString ? new PostgresDatabase(connectionString) : new DisabledDatabase();
}
