import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { routeSchemas } from '@config/route-schemas';

// Request params schema for GET /balance/:address
interface BalanceRequest {
  Params: {
    address: string;
  };
}

// Response schemas
interface BalanceSuccessResponse {
  address: string;
  balance: number;
}

interface BalanceErrorResponse {
  error: string;
  address?: string;
}

export async function balanceRoutes(fastify: FastifyInstance) {
  // Get services from fastify instance (injected during bootstrap)
  const balanceRepository = fastify.balanceRepository;

  // GET /balance/:address - Get balance for a specific address
  fastify.get<BalanceRequest>('/balance/:address', {
    schema: routeSchemas.getBalance
  }, async (request: FastifyRequest<BalanceRequest>, reply: FastifyReply) => {
    try {
      // Check if balance queries are safe to execute
      if (!fastify.services.concurrencyManager.canExecuteBalanceQuery()) {
        return reply.status(503).send({
          error: 'Balance queries temporarily unavailable during rollback operation'
        } as BalanceErrorResponse);
      }

      const { address } = request.params;

      // Validate address format
      if (!address || typeof address !== 'string') {
        return reply.status(400).send({
          error: 'Invalid address: must be a non-empty string',
          address: address
        } as BalanceErrorResponse);
      }

      // Trim whitespace and validate length
      const trimmedAddress = address.trim();
      if (trimmedAddress.length === 0) {
        return reply.status(400).send({
          error: 'Invalid address: cannot be empty or only whitespace',
          address: address
        } as BalanceErrorResponse);
      }

      if (trimmedAddress.length > 100) {
        return reply.status(400).send({
          error: 'Invalid address: too long (maximum 100 characters)',
          address: address
        } as BalanceErrorResponse);
      }

      // Additional address format validation
      // Check for basic address format (alphanumeric and common special characters)
      const addressRegex = /^[a-zA-Z0-9._-]+$/;
      if (!addressRegex.test(trimmedAddress)) {
        return reply.status(400).send({
          error: 'Invalid address format: only alphanumeric characters, dots, underscores, and hyphens are allowed',
          address: address
        } as BalanceErrorResponse);
      }

      // Get balance from repository
      const balance = await balanceRepository.getBalance(trimmedAddress);

      return reply.status(200).send({
        address: trimmedAddress,
        balance: balance
      } as BalanceSuccessResponse);

    } catch (error) {
      // Use structured error handling from injected service
      const structuredError = fastify.services.errorHandler.createStructuredError(
        error instanceof Error ? error : new Error(String(error)),
        {
          operation: 'balance_route_handler',
          address: request.params?.address,
          additionalData: { 
            endpoint: 'GET /balance/:address'
          }
        }
      );

      fastify.log.error({ 
        structuredError,
        originalError: error 
      }, 'Error retrieving balance');
      
      return reply.status(500).send({
        error: 'Internal server error while retrieving balance',
        address: request.params?.address
      } as BalanceErrorResponse);
    }
  });
}