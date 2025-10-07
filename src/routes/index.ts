import type { FastifyInstance } from 'fastify';
import { blockRoutes } from './blocks.js';
import { balanceRoutes } from './balance.js';
import { rollbackRoutes } from './rollback.js';
import { healthRoutes } from './health.js';

export async function registerRoutes(fastify: FastifyInstance) {
  // Health check endpoint
  fastify.get('/', {
    schema: {
      tags: ['Health'],
      summary: 'Service status check',
      description: 'Returns basic service status information',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            service: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' }
          }
        }
      }
    }
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