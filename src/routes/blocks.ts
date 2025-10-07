import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Block } from '../types/blockchain.js';

// Request body schema for POST /blocks
interface BlockRequest {
  Body: Block;
}

// Response schemas
interface BlockSuccessResponse {
  success: true;
  blockHeight: number;
  message: string;
}

interface BlockErrorResponse {
  success: false;
  error: string;
  blockHeight?: number;
}

export async function blockRoutes(fastify: FastifyInstance) {
  // Get services from fastify instance (injected during bootstrap)
  const blockProcessor = fastify.blockProcessor;

  // POST /blocks - Process a new block
  fastify.post<BlockRequest>('/blocks', {
    schema: {
      tags: ['Blocks'],
      summary: 'Process a new block',
      description: 'Submit a new block for processing and indexing in the blockchain',
      body: {
        type: 'object',
        required: ['height', 'id', 'transactions'],
        properties: {
          height: { type: 'number', minimum: 1 },
          id: { type: 'string', minLength: 1 },
          transactions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'inputs', 'outputs'],
              properties: {
                id: { type: 'string', minLength: 1 },
                inputs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['txId', 'index'],
                    properties: {
                      txId: { type: 'string', minLength: 1 },
                      index: { type: 'number', minimum: 0 }
                    }
                  }
                },
                outputs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['address', 'value'],
                    properties: {
                      address: { type: 'string', minLength: 1 },
                      value: { type: 'number', minimum: 0 }
                    }
                  }
                }
              }
            }
          }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            blockHeight: { type: 'number' },
            message: { type: 'string' }
          }
        },
        400: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
            blockHeight: { type: 'number' }
          }
        },
        409: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
            blockHeight: { type: 'number' }
          }
        },
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
            blockHeight: { type: 'number' }
          }
        }
      }
    }
  }, async (request: FastifyRequest<BlockRequest>, reply: FastifyReply) => {
    try {
      const block = request.body;

      // Additional validation for block structure
      if (!block || typeof block !== 'object') {
        return reply.status(400).send({
          success: false,
          error: 'Invalid block data: block must be an object'
        } as BlockErrorResponse);
      }

      // Validate required fields are present and properly typed
      if (typeof block.height !== 'number' || block.height < 1) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid block height: must be a positive number',
          blockHeight: block.height
        } as BlockErrorResponse);
      }

      if (typeof block.id !== 'string' || block.id.trim().length === 0) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid block ID: must be a non-empty string',
          blockHeight: block.height
        } as BlockErrorResponse);
      }

      if (!Array.isArray(block.transactions)) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid transactions: must be an array',
          blockHeight: block.height
        } as BlockErrorResponse);
      }

      // Validate each transaction structure
      for (let i = 0; i < block.transactions.length; i++) {
        const tx = block.transactions[i];
        
        if (!tx || typeof tx !== 'object') {
          return reply.status(400).send({
            success: false,
            error: `Invalid transaction ${i}: must be an object`,
            blockHeight: block.height
          } as BlockErrorResponse);
        }

        if (typeof tx.id !== 'string' || tx.id.trim().length === 0) {
          return reply.status(400).send({
            success: false,
            error: `Invalid transaction ${i} ID: must be a non-empty string`,
            blockHeight: block.height
          } as BlockErrorResponse);
        }

        if (!Array.isArray(tx.inputs)) {
          return reply.status(400).send({
            success: false,
            error: `Invalid transaction ${i} inputs: must be an array`,
            blockHeight: block.height
          } as BlockErrorResponse);
        }

        if (!Array.isArray(tx.outputs)) {
          return reply.status(400).send({
            success: false,
            error: `Invalid transaction ${i} outputs: must be an array`,
            blockHeight: block.height
          } as BlockErrorResponse);
        }

        // Validate inputs
        for (let j = 0; j < tx.inputs.length; j++) {
          const input = tx.inputs[j];
          if (!input || typeof input !== 'object') {
            return reply.status(400).send({
              success: false,
              error: `Invalid transaction ${i} input ${j}: must be an object`,
              blockHeight: block.height
            } as BlockErrorResponse);
          }

          if (typeof input.txId !== 'string' || input.txId.trim().length === 0) {
            return reply.status(400).send({
              success: false,
              error: `Invalid transaction ${i} input ${j} txId: must be a non-empty string`,
              blockHeight: block.height
            } as BlockErrorResponse);
          }

          if (typeof input.index !== 'number' || input.index < 0 || !Number.isInteger(input.index)) {
            return reply.status(400).send({
              success: false,
              error: `Invalid transaction ${i} input ${j} index: must be a non-negative integer`,
              blockHeight: block.height
            } as BlockErrorResponse);
          }
        }

        // Validate outputs
        for (let j = 0; j < tx.outputs.length; j++) {
          const output = tx.outputs[j];
          if (!output || typeof output !== 'object') {
            return reply.status(400).send({
              success: false,
              error: `Invalid transaction ${i} output ${j}: must be an object`,
              blockHeight: block.height
            } as BlockErrorResponse);
          }

          if (typeof output.address !== 'string' || output.address.trim().length === 0) {
            return reply.status(400).send({
              success: false,
              error: `Invalid transaction ${i} output ${j} address: must be a non-empty string`,
              blockHeight: block.height
            } as BlockErrorResponse);
          }

          if (typeof output.value !== 'number' || output.value < 0 || !Number.isFinite(output.value)) {
            return reply.status(400).send({
              success: false,
              error: `Invalid transaction ${i} output ${j} value: must be a non-negative finite number`,
              blockHeight: block.height
            } as BlockErrorResponse);
          }
        }
      }

      // Process the block
      const result = await blockProcessor.processBlock(block);

      if (result.success) {
        return reply.status(200).send({
          success: true,
          blockHeight: result.blockHeight,
          message: result.message || `Block ${result.blockHeight} processed successfully`
        } as BlockSuccessResponse);
      } else {
        // Determine appropriate error status code based on error message
        let statusCode = 400; // Default to bad request

        if (result.error) {
          // Check for specific error types
          if (result.error.includes('already processed') || 
              result.error.includes('duplicate')) {
            statusCode = 409; // Conflict for duplicate blocks
          } else if (result.error.includes('Block height must be') || 
              result.error.includes('First block must have height')) {
            statusCode = 400; // Bad request for validation errors
          } else if (result.error.includes('database') || 
                     result.error.includes('connection')) {
            statusCode = 500; // Internal server error for database issues
          }
        }

        return reply.status(statusCode).send({
          success: false,
          error: result.error || 'Block processing failed',
          blockHeight: result.blockHeight
        } as BlockErrorResponse);
      }

    } catch (error) {
      // Use structured error handling from injected service
      const structuredError = fastify.services.errorHandler.createStructuredError(
        error instanceof Error ? error : new Error(String(error)),
        {
          operation: 'block_route_handler',
          blockHeight: request.body?.height,
          additionalData: { 
            blockId: request.body?.id,
            endpoint: 'POST /blocks'
          }
        }
      );

      fastify.log.error({ 
        structuredError,
        originalError: error 
      }, 'Unexpected error processing block');
      
      return reply.status(500).send({
        success: false,
        error: 'Internal server error while processing block'
      } as BlockErrorResponse);
    }
  });
}