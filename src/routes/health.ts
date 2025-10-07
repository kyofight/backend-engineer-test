import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { errorHandler } from '@services/error-handler.js';
import { concurrencyManager } from '@services/concurrency-manager.js';
import { routeSchemas } from '@config/route-schemas.js';

// Response schemas
interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  database: {
    connected: boolean;
    connectionCount?: number;
  };
  concurrency: {
    queueLength: number;
    isProcessingBlocks: boolean;
    rollbackInProgress: boolean;
  };
  errors: {
    totalErrors: number;
    recentErrors: number;
    dailyErrors: number;
    errorsByType: Record<string, number>;
    errorsBySeverity: Record<string, number>;
    lastError: any;
  };
}

export async function healthRoutes(fastify: FastifyInstance) {
  // GET /health - System health and monitoring endpoint
  fastify.get('/health', {
    schema: routeSchemas.healthCheck
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const dbManager = fastify.dbManager;
      
      // Check database connectivity using database manager
      let databaseStatus = { connected: false, connectionCount: 0 };
      try {
        const dbStatus = dbManager.getStatus();
        databaseStatus.connected = dbStatus.connected;
        
        const db = dbManager.getConnection();
        if (db) {
          const pool = db.getPool();
          databaseStatus.connectionCount = pool.totalCount;
        }
      } catch (error) {
        databaseStatus.connected = false;
      }

      // Get concurrency status
      const concurrencyStatus = concurrencyManager.getStatus();

      // Get error statistics
      const errorStats = errorHandler.getErrorStatistics();

      // Clean up old errors periodically
      errorHandler.clearOldErrors();

      // Determine overall health status
      let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

      if (!databaseStatus.connected) {
        overallStatus = 'unhealthy';
      } else if (errorStats.recentErrors > 10 || concurrencyStatus.queueLength > 50) {
        overallStatus = 'degraded';
      } else if (errorStats.recentErrors > 5 || concurrencyStatus.queueLength > 20) {
        overallStatus = 'degraded';
      }

      const healthResponse: HealthResponse = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: databaseStatus,
        concurrency: concurrencyStatus,
        errors: errorStats
      };

      return reply.status(200).send(healthResponse);

    } catch (error) {
      // Even health endpoint errors should be logged
      const structuredError = errorHandler.createStructuredError(
        error instanceof Error ? error : new Error(String(error)),
        {
          operation: 'health_check',
          additionalData: { endpoint: 'GET /health' }
        }
      );

      fastify.log.error({ 
        structuredError,
        originalError: error 
      }, 'Error in health check endpoint');

      return reply.status(500).send({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: 'Health check failed'
      });
    }
  });

  // GET /metrics - Detailed metrics for monitoring systems
  fastify.get('/metrics', {
    schema: routeSchemas.metrics
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const dbManager = fastify.dbManager;
      
      // Get detailed metrics
      const errorStats = errorHandler.getErrorStatistics();
      const concurrencyStatus = concurrencyManager.getStatus();

      // Database metrics
      let dbMetrics = {};
      try {
        const db = dbManager.getConnection();
        if (db) {
          const pool = db.getPool();
          dbMetrics = {
            database_connections_total: pool.totalCount,
            database_connections_idle: pool.idleCount,
            database_connections_waiting: pool.waitingCount
          };
        } else {
          dbMetrics = {
            database_connections_total: 0,
            database_connections_idle: 0,
            database_connections_waiting: 0
          };
        }
      } catch (error) {
        dbMetrics = {
          database_connections_total: 0,
          database_connections_idle: 0,
          database_connections_waiting: 0
        };
      }

      // Get memory usage and flatten it
      const memoryUsage = process.memoryUsage();

      const metrics = {
        // System metrics
        uptime_seconds: process.uptime(),
        memory_usage_rss: memoryUsage.rss,
        memory_usage_heap_total: memoryUsage.heapTotal,
        memory_usage_heap_used: memoryUsage.heapUsed,
        memory_usage_external: memoryUsage.external,
        memory_usage_array_buffers: memoryUsage.arrayBuffers,
        
        // Database metrics
        ...dbMetrics,
        
        // Concurrency metrics
        block_processing_queue_length: concurrencyStatus.queueLength,
        block_processing_active: concurrencyStatus.isProcessingBlocks ? 1 : 0,
        rollback_in_progress: concurrencyStatus.rollbackInProgress ? 1 : 0,
        
        // Error metrics
        errors_total: errorStats.totalErrors,
        errors_recent_1h: errorStats.recentErrors,
        errors_daily: errorStats.dailyErrors,
        
        // Error breakdown by type
        ...Object.entries(errorStats.errorsByType).reduce((acc, [type, count]) => {
          acc[`errors_by_type_${type.toLowerCase()}`] = count;
          return acc;
        }, {} as Record<string, number>),
        
        // Error breakdown by severity
        ...Object.entries(errorStats.errorsBySeverity).reduce((acc, [severity, count]) => {
          acc[`errors_by_severity_${severity.toLowerCase()}`] = count;
          return acc;
        }, {} as Record<string, number>)
      };

      return reply.status(200).send(metrics);

    } catch (error) {
      const structuredError = errorHandler.createStructuredError(
        error instanceof Error ? error : new Error(String(error)),
        {
          operation: 'metrics_endpoint',
          additionalData: { endpoint: 'GET /metrics' }
        }
      );

      fastify.log.error({ 
        structuredError,
        originalError: error 
      }, 'Error in metrics endpoint');

      return reply.status(500).send({
        error: 'Metrics collection failed'
      });
    }
  });
}