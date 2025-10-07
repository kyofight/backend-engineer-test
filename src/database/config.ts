import type { PoolConfig } from 'pg';

export interface DatabaseConfig {
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  maxConnections?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

export function createDatabaseConfig(config: DatabaseConfig): PoolConfig {
  if (config.url) {
    return {
      connectionString: config.url,
      max: config.maxConnections || 20,
      idleTimeoutMillis: config.idleTimeoutMs || 30000,
      connectionTimeoutMillis: config.connectionTimeoutMs || 2000,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
    };
  }

  return {
    host: config.host || 'localhost',
    port: config.port || 5432,
    database: config.database || 'blockchain_indexer',
    user: config.user || 'postgres',
    password: config.password || 'postgres',
    max: config.maxConnections || 20,
    idleTimeoutMillis: config.idleTimeoutMs || 30000,
    connectionTimeoutMillis: config.connectionTimeoutMs || 2000,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
  };
}

export function getDatabaseConfigFromEnv(): DatabaseConfig {
  return {
    url: process.env.DATABASE_URL,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : undefined,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true',
    maxConnections: process.env.DB_MAX_CONNECTIONS ? parseInt(process.env.DB_MAX_CONNECTIONS) : undefined,
    idleTimeoutMs: process.env.DB_IDLE_TIMEOUT_MS ? parseInt(process.env.DB_IDLE_TIMEOUT_MS) : undefined,
    connectionTimeoutMs: process.env.DB_CONNECTION_TIMEOUT_MS ? parseInt(process.env.DB_CONNECTION_TIMEOUT_MS) : undefined,
  };
}