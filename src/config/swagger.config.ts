import type { FastifyDynamicSwaggerOptions } from '@fastify/swagger';
import type { FastifySwaggerUiOptions } from '@fastify/swagger-ui';

export const swaggerOptions: FastifyDynamicSwaggerOptions = {
  openapi: {
    openapi: '3.0.0',
    info: {
      title: 'Blockchain Indexer API',
      description: 'A blockchain indexer service that processes blocks, manages balances, and provides rollback functionality',
      version: '1.0.0',
      contact: {
        name: 'API Support',
        email: 'support@blockchain-indexer.com'
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT'
      }
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Development server'
      }
    ],
    tags: [
      {
        name: 'Health',
        description: 'Health check and monitoring endpoints'
      },
      {
        name: 'Blocks',
        description: 'Block processing operations'
      },
      {
        name: 'Balance',
        description: 'Address balance queries'
      },
      {
        name: 'Rollback',
        description: 'Blockchain state rollback operations'
      }
    ],
    components: {
      schemas: {
        Block: {
          type: 'object',
          required: ['height', 'id', 'transactions'],
          properties: {
            height: {
              type: 'number',
              minimum: 1,
              description: 'Block height in the blockchain',
              example: 12345
            },
            id: {
              type: 'string',
              minLength: 1,
              description: 'Unique block identifier',
              example: 'block_abc123def456'
            },
            transactions: {
              type: 'array',
              items: { $ref: '#/components/schemas/Transaction' },
              description: 'List of transactions in the block'
            }
          }
        },
        Transaction: {
          type: 'object',
          required: ['id', 'inputs', 'outputs'],
          properties: {
            id: {
              type: 'string',
              minLength: 1,
              description: 'Unique transaction identifier',
              example: 'tx_xyz789abc123'
            },
            inputs: {
              type: 'array',
              items: { $ref: '#/components/schemas/Input' },
              description: 'Transaction inputs (UTXOs being spent)'
            },
            outputs: {
              type: 'array',
              items: { $ref: '#/components/schemas/Output' },
              description: 'Transaction outputs (new UTXOs being created)'
            }
          }
        },
        Input: {
          type: 'object',
          required: ['txId', 'index'],
          properties: {
            txId: {
              type: 'string',
              minLength: 1,
              description: 'Transaction ID of the UTXO being spent',
              example: 'tx_previous123'
            },
            index: {
              type: 'number',
              minimum: 0,
              description: 'Output index in the referenced transaction',
              example: 0
            }
          }
        },
        Output: {
          type: 'object',
          required: ['address', 'value'],
          properties: {
            address: {
              type: 'string',
              minLength: 1,
              description: 'Recipient address',
              example: 'addr_user123'
            },
            value: {
              type: 'number',
              minimum: 0,
              description: 'Amount being transferred',
              example: 100.50
            }
          }
        },
        BalanceResponse: {
          type: 'object',
          required: ['address', 'balance'],
          properties: {
            address: {
              type: 'string',
              description: 'The queried address',
              example: 'addr_user123'
            },
            balance: {
              type: 'number',
              description: 'Current balance for the address',
              example: 250.75
            }
          }
        },
        BlockProcessingResponse: {
          type: 'object',
          required: ['success', 'blockHeight', 'message'],
          properties: {
            success: {
              type: 'boolean',
              description: 'Whether the block was processed successfully',
              example: true
            },
            blockHeight: {
              type: 'number',
              description: 'Height of the processed block',
              example: 12345
            },
            message: {
              type: 'string',
              description: 'Success message',
              example: 'Block 12345 processed successfully'
            }
          }
        },
        RollbackRequest: {
          type: 'object',
          required: ['height'],
          properties: {
            height: {
              type: 'number',
              minimum: 0,
              description: 'Target height to rollback to',
              example: 12340
            }
          }
        },
        RollbackResponse: {
          type: 'object',
          required: ['success', 'newHeight', 'message'],
          properties: {
            success: {
              type: 'boolean',
              description: 'Whether the rollback was successful',
              example: true
            },
            newHeight: {
              type: 'number',
              description: 'New blockchain height after rollback',
              example: 12340
            },
            message: {
              type: 'string',
              description: 'Rollback result message',
              example: 'Successfully rolled back to height 12340'
            }
          }
        },
        HealthResponse: {
          type: 'object',
          required: ['status', 'timestamp', 'uptime', 'database', 'concurrency', 'errors'],
          properties: {
            status: {
              type: 'string',
              enum: ['healthy', 'degraded', 'unhealthy'],
              description: 'Overall system health status',
              example: 'healthy'
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
              description: 'Health check timestamp',
              example: '2024-01-15T10:30:00.000Z'
            },
            uptime: {
              type: 'number',
              description: 'System uptime in seconds',
              example: 3600
            },
            database: {
              type: 'object',
              properties: {
                connected: {
                  type: 'boolean',
                  description: 'Database connection status',
                  example: true
                },
                connectionCount: {
                  type: 'number',
                  description: 'Number of active database connections',
                  example: 5
                }
              }
            },
            concurrency: {
              type: 'object',
              properties: {
                queueLength: {
                  type: 'number',
                  description: 'Number of queued operations',
                  example: 0
                },
                isProcessingBlocks: {
                  type: 'boolean',
                  description: 'Whether blocks are currently being processed',
                  example: false
                },
                rollbackInProgress: {
                  type: 'boolean',
                  description: 'Whether a rollback operation is in progress',
                  example: false
                }
              }
            },
            errors: {
              type: 'object',
              properties: {
                totalErrors: {
                  type: 'number',
                  description: 'Total error count',
                  example: 0
                },
                recentErrors: {
                  type: 'number',
                  description: 'Recent error count (last hour)',
                  example: 0
                },
                dailyErrors: {
                  type: 'number',
                  description: 'Daily error count',
                  example: 0
                },
                errorsByType: {
                  type: 'object',
                  additionalProperties: { type: 'number' },
                  description: 'Error count by type'
                },
                errorsBySeverity: {
                  type: 'object',
                  additionalProperties: { type: 'number' },
                  description: 'Error count by severity'
                },
                lastError: {
                  type: 'object',
                  description: 'Last error details'
                }
              }
            }
          }
        },
        ErrorResponse: {
          type: 'object',
          required: ['success', 'error'],
          properties: {
            success: {
              type: 'boolean',
              description: 'Always false for error responses',
              example: false
            },
            error: {
              type: 'string',
              description: 'Error message',
              example: 'Invalid block data'
            },
            blockHeight: {
              type: 'number',
              description: 'Block height related to the error (if applicable)',
              example: 12345
            },
            address: {
              type: 'string',
              description: 'Address related to the error (if applicable)',
              example: 'addr_user123'
            },
            targetHeight: {
              type: 'number',
              description: 'Target height related to the error (if applicable)',
              example: 12340
            }
          }
        },
        ServiceStatus: {
          type: 'object',
          required: ['status', 'service', 'timestamp'],
          properties: {
            status: {
              type: 'string',
              description: 'Service status',
              example: 'ok'
            },
            service: {
              type: 'string',
              description: 'Service name',
              example: 'blockchain-indexer'
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
              description: 'Status check timestamp',
              example: '2024-01-15T10:30:00.000Z'
            }
          }
        }
      }
    }
  }
};

export const swaggerUiOptions: FastifySwaggerUiOptions = {
  routePrefix: '/docs',
  uiConfig: {
    docExpansion: 'list',
    deepLinking: false
  },
  uiHooks: {
    onRequest: function (request, reply, next) { next(); },
    preHandler: function (request, reply, next) { next(); }
  },
  staticCSP: true,
  transformStaticCSP: (header) => header,
  transformSpecification: (swaggerObject, request, reply) => { return swaggerObject; },
  transformSpecificationClone: true
};