import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { routeSchemas } from '@config/route-schemas';

// Request body schema for POST /rollback
interface RollbackRequest {
  Body: {
    height: any; // Allow any type for proper validation
  };
}

// Response schemas
interface RollbackSuccessResponse {
  success: true;
  newHeight: number;
  message: string;
}

interface RollbackErrorResponse {
  success: false;
  error: string;
  targetHeight?: number;
}

export async function rollbackRoutes(fastify: FastifyInstance) {
  // Get services from fastify instance (injected during bootstrap)
  const blockProcessor = fastify.blockProcessor;

  // POST /rollback - Rollback blockchain state to a specific height
  fastify.post<RollbackRequest>('/rollback', {
    schema: routeSchemas.rollback
  }, async (request: FastifyRequest<RollbackRequest>, reply: FastifyReply) => {
    try {
      const { height } = request.body;

      // Validate height parameter - check for null first
      if (height === null) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid height: cannot be null',
          targetHeight: height
        } as RollbackErrorResponse);
      }

      if (height === undefined || typeof height !== 'number') {
        return reply.status(400).send({
          success: false,
          error: 'Invalid height: must be a number',
          targetHeight: height
        } as RollbackErrorResponse);
      }

      if (!Number.isInteger(height)) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid height: must be an integer',
          targetHeight: height
        } as RollbackErrorResponse);
      }

      if (height < 0) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid height: cannot be negative',
          targetHeight: height
        } as RollbackErrorResponse);
      }

      // Perform rollback operation
      const result = await blockProcessor.rollbackToHeight(height);

      if (result.success) {
        return reply.status(200).send({
          success: true,
          newHeight: result.blockHeight,
          message: result.message || `Successfully rolled back to height ${result.blockHeight}`
        } as RollbackSuccessResponse);
      } else {
        // Determine appropriate error status code based on error message
        let statusCode = 400; // Default to bad request

        if (result.error) {
          // Check for specific error types
          if (result.error.includes('Target height') &&
            result.error.includes('is greater than current height')) {
            statusCode = 400; // Bad request for invalid target height
          } else if (result.error.includes('Rollback limited to 2000 blocks')) {
            statusCode = 409; // Conflict for rollback limit exceeded
          } else if (result.error.includes('cannot be negative')) {
            statusCode = 400; // Bad request for negative height
          } else if (result.error.includes('database') ||
            result.error.includes('connection') ||
            result.error.includes('Rollback failed')) {
            statusCode = 500; // Internal server error for database issues
          }
        }

        return reply.status(statusCode).send({
          success: false,
          error: result.error || 'Rollback operation failed',
          targetHeight: result.blockHeight
        } as RollbackErrorResponse);
      }

    } catch (error) {
      // Use structured error handling from injected service
      const structuredError = fastify.services.errorHandler.createStructuredError(
        error instanceof Error ? error : new Error(String(error)),
        {
          operation: 'rollback_route_handler',
          blockHeight: request.body?.height,
          additionalData: {
            endpoint: 'POST /rollback'
          }
        }
      );

      fastify.log.error({
        structuredError,
        originalError: error
      }, 'Unexpected error during rollback');

      return reply.status(500).send({
        success: false,
        error: 'Internal server error during rollback operation',
        targetHeight: request.body?.height
      } as RollbackErrorResponse);
    }
  });
}