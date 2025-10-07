// Shared route schema definitions
// This file contains the actual route schemas used by both the route handlers and the generation script

export const routeSchemas = {
  // Health endpoints
  healthStatus: {
    tags: ["Health"],
    summary: "Service status check",
    description: "Returns basic service status information",
    response: {
      200: {
        type: "object",
        properties: {
          status: { type: "string", example: "ok" },
          service: { type: "string", example: "blockchain-indexer" },
          timestamp: { type: "string", format: "date-time" },
        },
      },
    },
  },

  healthCheck: {
    tags: ["Health"],
    summary: "System health check",
    description:
      "Get detailed system health information including database status, concurrency metrics, and error statistics",
    response: {
      200: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["healthy", "degraded", "unhealthy"],
          },
          timestamp: { type: "string", format: "date-time" },
          uptime: { type: "number" },
          database: { type: "object" },
          concurrency: { type: "object" },
          errors: { type: "object" },
        },
      },
      500: {
        type: "object",
        properties: {
          error: { type: "string" },
        },
      },
    },
  },

  metrics: {
    tags: ["Health"],
    summary: "System metrics",
    description: "Get detailed system metrics for monitoring and observability",
    response: {
      200: {
        type: "object",
        additionalProperties: { type: "number" },
        description: "Key-value pairs of system metrics",
      },
      500: {
        type: "object",
        properties: {
          error: { type: "string" },
        },
      },
    },
  },

  // Block processing endpoint
  processBlock: {
    tags: ["Blocks"],
    summary: "Process a new block",
    description:
      "Submit a new block for processing and indexing in the blockchain",
    body: {
      type: "object",
      required: ["height", "id", "transactions"],
      properties: {
        height: { type: "number", minimum: 1 },
        id: { type: "string", minLength: 1 },
        transactions: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "inputs", "outputs"],
            properties: {
              id: { type: "string", minLength: 1 },
              inputs: {
                type: "array",
                items: {
                  type: "object",
                  required: ["txId", "index"],
                  properties: {
                    txId: { type: "string", minLength: 1 },
                    index: { type: "number", minimum: 0 },
                  },
                },
              },
              outputs: {
                type: "array",
                items: {
                  type: "object",
                  required: ["address", "value"],
                  properties: {
                    address: { type: "string", minLength: 1 },
                    value: { type: "number", minimum: 0 },
                  },
                },
              },
            },
          },
        },
      },
    },
    response: {
      200: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          blockHeight: { type: "number" },
          message: { type: "string" },
        },
      },
      400: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          error: { type: "string" },
          blockHeight: { type: "number" },
        },
      },
      409: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          error: { type: "string" },
          blockHeight: { type: "number" },
        },
      },
      500: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          error: { type: "string" },
          blockHeight: { type: "number" },
        },
      },
    },
  },

  // Balance query endpoint
  getBalance: {
    tags: ["Balance"],
    summary: "Get address balance",
    description:
      "Retrieve the current balance for a specific blockchain address",
    params: {
      type: "object",
      required: ["address"],
      properties: {
        address: {
          type: "string",
          description: "Blockchain address to query",
        },
      },
    },
    response: {
      200: {
        type: "object",
        properties: {
          address: { type: "string" },
          balance: { type: "number" },
        },
      },
      400: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          error: { type: "string" },
          address: { type: "string" },
        },
      },
      500: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          error: { type: "string" },
          address: { type: "string" },
        },
      },
      503: {
        type: "object",
        properties: {
          error: { type: "string" },
        },
      },
    },
  },

  // Rollback endpoint
  rollback: {
    tags: ["Rollback"],
    summary: "Rollback blockchain state",
    description:
      "Rollback the blockchain state to a specific height, removing all blocks and transactions above that height",
    body: {
      type: "object",
      required: ["height"],
      properties: {
        height: {
          type: "number",
          minimum: 0,
          description: "Target height to rollback to",
        },
      },
    },
    response: {
      200: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          newHeight: { type: "number" },
          message: { type: "string" },
        },
      },
      400: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          error: { type: "string" },
          targetHeight: { type: "number" },
        },
      },
      409: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          error: { type: "string" },
          targetHeight: { type: "number" },
        },
      },
      500: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          error: { type: "string" },
          targetHeight: { type: "number" },
        },
      },
    },
  },
};
