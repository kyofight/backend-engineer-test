import type { FastifyInstance } from 'fastify';
import { blockRoutes } from '@routes/blocks';
import { balanceRoutes } from '@routes/balance';
import { rollbackRoutes } from '@routes/rollback';
import { healthRoutes } from '@routes/health';
import { routeSchemas } from '@config/route-schemas';

export async function registerRoutes(fastify: FastifyInstance) {
  // Health check endpoint
  fastify.get('/', {
    schema: routeSchemas.healthStatus
  }, async (request, reply) => {
    return { 
      status: 'ok',
      service: 'blockchain-indexer',
      timestamp: new Date().toISOString()
    };
  });

  // Register all API routes
  await fastify.register(blockRoutes);
  await fastify.register(balanceRoutes);
  await fastify.register(rollbackRoutes);
  await fastify.register(healthRoutes);
}