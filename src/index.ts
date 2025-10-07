import Fastify, { type FastifyInstance } from 'fastify';
import { DatabaseConnection } from './database/index.js';
import { registerRoutes } from './routes/index.js';
import { BlockProcessor } from './services/block-processor.js';
import { concurrencyManager } from './services/concurrency-manager.js';
import { errorHandler } from './services/error-handler.js';
import { DatabaseManager } from './services/database-manager.js';
import { UTXORepository } from './database/repositories/utxo-repository.js';
import { BalanceRepository } from './database/repositories/balance-repository.js';
import { loadConfig, type AppConfig } from './config/app.config.js';
import { swaggerOptions, swaggerUiOptions } from './config/swagger.config.js';

// Type declarations moved to src/types/fastify.d.ts



// Initialize Fastify with configuration
function createFastifyInstance(config: AppConfig) {
  return Fastify({
    logger: {
      level: config.logLevel,
      transport: config.environment === 'development' ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname'
        }
      } : undefined
    }
  });
}

// Initialize database manager (non-blocking)
async function initializeDatabaseManager(config: AppConfig): Promise<DatabaseManager> {
  console.log('Initializing database manager...');

  // Create database manager with configuration from environment
  const dbManagerConfig = {
    maxReconnectAttempts: parseInt(process.env.DB_MAX_RECONNECT_ATTEMPTS || '-1'),
    reconnectBaseDelayMs: parseInt(process.env.DB_RECONNECT_BASE_DELAY_MS || '1000'),
    reconnectMaxDelayMs: parseInt(process.env.DB_RECONNECT_MAX_DELAY_MS || '30000'),
    reconnectBackoffMultiplier: parseFloat(process.env.DB_RECONNECT_BACKOFF_MULTIPLIER || '1.5'),
    healthCheckIntervalMs: parseInt(process.env.DB_HEALTH_CHECK_INTERVAL_MS || '30000'),
    connectionTimeoutMs: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '10000')
  };

  const dbManager = new DatabaseManager(config, dbManagerConfig);

  // Initialize database manager (starts connection attempts in background)
  await dbManager.initialize();

  console.log('Database manager initialized successfully');
  return dbManager;
}

// Initialize all services and repositories with database manager
function initializeServices(dbManager: DatabaseManager) {
  console.log('Initializing services and repositories...');

  // Initialize repositories with database manager
  const utxoRepository = new UTXORepository(dbManager);
  const balanceRepository = new BalanceRepository(dbManager);

  // Initialize services with database manager
  const blockProcessor = new BlockProcessor(dbManager);

  console.log('Services and repositories initialized successfully');

  return {
    utxoRepository,
    balanceRepository,
    blockProcessor,
    services: {
      concurrencyManager,
      errorHandler
    }
  };
}

// Register all dependencies with Fastify
function registerDependencies(
  fastify: FastifyInstance,
  dbManager: DatabaseManager,
  services: ReturnType<typeof initializeServices>
) {
  console.log('Registering dependencies with Fastify...');

  // Register database manager
  fastify.decorate('dbManager', dbManager as any);

  // Register database connection (for backward compatibility, may be null)
  fastify.decorate('db', dbManager.getConnection() as any);

  // Register repositories
  fastify.decorate('utxoRepository', services.utxoRepository as any);
  fastify.decorate('balanceRepository', services.balanceRepository as any);

  // Register services
  fastify.decorate('blockProcessor', services.blockProcessor as any);
  fastify.decorate('services', services.services);

  console.log('Dependencies registered successfully');
}

// Setup graceful shutdown
function setupGracefulShutdown(
  fastify: FastifyInstance,
  dbManager: DatabaseManager
) {
  const gracefulShutdown = async (signal: string) => {
    console.log(`Received ${signal}, starting graceful shutdown...`);

    try {
      // Stop accepting new requests
      await fastify.close();
      console.log('Fastify server closed');

      // Clear any pending operations
      concurrencyManager.clearQueue();
      console.log('Cleared pending operations');

      // Shutdown database manager
      await dbManager.shutdown();
      console.log('Database manager shutdown completed');

      console.log('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      console.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  };

  // Register signal handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Handle uncaught exceptions and unhandled rejections
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('unhandledRejection');
  });
}

// Setup health monitoring
function setupHealthMonitoring(fastify: FastifyInstance) {
  // Periodic error log cleanup
  setInterval(() => {
    errorHandler.clearOldErrors();
  }, 60 * 60 * 1000); // Clean up every hour

  // Log system status periodically in development
  if (process.env.NODE_ENV === 'development') {
    setInterval(() => {
      const concurrencyStatus = concurrencyManager.getStatus();
      const errorStats = errorHandler.getErrorStatistics();

      fastify.log.info({
        concurrency: concurrencyStatus,
        errors: {
          total: errorStats.totalErrors,
          recent: errorStats.recentErrors,
          lastError: errorStats.lastError?.message
        }
      }, 'System status');
    }, 5 * 60 * 1000); // Log every 5 minutes
  }
}

// Main bootstrap function (now database-optional)
async function bootstrap(): Promise<void> {
  console.log('Starting blockchain indexer bootstrap...');

  try {
    // Load configuration
    const config = loadConfig();
    console.log(`Environment: ${config.environment}`);
    console.log(`Port: ${config.port}`);
    console.log(`Host: ${config.host}`);

    // Create Fastify instance
    const fastify = createFastifyInstance(config);

    // Initialize database manager (non-blocking)
    const dbManager = await initializeDatabaseManager(config);

    // Initialize services and repositories with database manager
    const services = initializeServices(dbManager);

    // Register dependencies with Fastify
    registerDependencies(fastify, dbManager, services);

    // Register Swagger documentation first
    await fastify.register(import('@fastify/swagger'), swaggerOptions);
    await fastify.register(import('@fastify/swagger-ui'), swaggerUiOptions);
    console.log('Swagger documentation registered successfully');

    // Register API routes after Swagger
    await registerRoutes(fastify);
    console.log('API routes registered successfully');

    // Setup graceful shutdown
    setupGracefulShutdown(fastify, dbManager);

    // Setup health monitoring
    setupHealthMonitoring(fastify);

    // Start the server
    console.log('Starting server...');
    await fastify.listen({
      port: config.port,
      host: config.host
    });

    console.log(`Blockchain indexer started successfully on ${config.host}:${config.port}`);
    console.log(`API documentation available at: http://${config.host}:${config.port}/docs`);

    // Log database status
    const dbStatus = dbManager.getStatus();
    if (dbStatus.connected) {
      console.log('Database is connected and ready');
    } else {
      console.log('Database connection is being established in the background');
      console.log('API will be available with limited functionality until database is ready');
    }

    console.log('Bootstrap completed successfully');

  } catch (error) {
    console.error('Bootstrap failed:', error);
    process.exit(1);
  }
}

// Start the application
bootstrap().catch((error) => {
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});