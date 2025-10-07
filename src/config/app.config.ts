/**
 * Application Configuration
 * Centralized configuration management for the blockchain indexer
 */

export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  logLevel: string;
  environment: string;
}

/**
 * Load configuration from environment variables with validation
 * @returns AppConfig object with validated configuration
 */
export function loadConfig(): AppConfig {
  const config: AppConfig = {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    databaseUrl: process.env.DATABASE_URL || '',
    logLevel: process.env.LOG_LEVEL || 'info',
    environment: process.env.NODE_ENV || 'development'
  };

  // Validate required configuration
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  if (isNaN(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('PORT must be a valid port number between 1 and 65535');
  }

  // Validate log level
  const validLogLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
  if (!validLogLevels.includes(config.logLevel)) {
    throw new Error(`LOG_LEVEL must be one of: ${validLogLevels.join(', ')}`);
  }

  // Validate environment
  const validEnvironments = ['development', 'test', 'production'];
  if (!validEnvironments.includes(config.environment)) {
    console.warn(`Unknown environment: ${config.environment}. Valid environments: ${validEnvironments.join(', ')}`);
  }

  return config;
}

/**
 * Get default configuration for testing
 * @returns AppConfig object with test defaults
 */
export function getTestConfig(): AppConfig {
  return {
    port: 0, // Let the system assign a port
    host: '127.0.0.1',
    databaseUrl: process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test',
    logLevel: 'silent',
    environment: 'test'
  };
}