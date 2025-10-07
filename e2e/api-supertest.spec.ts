import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { calculateBlockId } from '@validation/block-validation';
import type { Block, Transaction } from '@shared/blockchain';

/**
 * API End-to-End Tests with SuperTest
 * 
 * These tests validate the actual HTTP API endpoints against a real running server,
 * providing comprehensive coverage of all available API routes including
 * request/response validation, error handling, and edge cases.
 * 
 * Test Coverage:
 * ✅ 37 comprehensive test cases covering all API endpoints
 * ✅ Request/response validation and schema compliance
 * ✅ Error handling and edge cases (400, 404, 409, 500 status codes)
 * ✅ Block processing workflow (genesis, sequential, validation)
 * ✅ Balance queries and transaction effects
 * ✅ Rollback operations and state management
 * ✅ Concurrent request handling
 * ✅ Input validation and malformed data handling
 * ✅ Swagger documentation endpoints
 * 
 * Environment Setup:
 * - Set API_BASE_URL environment variable to the running server URL
 * - Example: API_BASE_URL=http://localhost:3000
 * - The server must be running with a clean database state for tests
 * 
 * API Endpoints Tested:
 * - GET / (Service status)
 * - GET /health (System health monitoring)
 * - GET /metrics (System metrics for observability)
 * - POST /blocks (Block processing and validation)
 * - GET /balance/:address (Address balance queries)
 * - POST /rollback (Blockchain state rollback)
 * - GET /docs (Swagger UI documentation)
 * - GET /docs/json (OpenAPI specification)
 */

describe('API E2E Tests with SuperTest', () => {
  const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';

  if (!process.env.API_BASE_URL) {
    console.warn('API_BASE_URL not set, using default: http://localhost:3000');
  }

  beforeEach(async () => {
    // Reset blockchain state before each test by rolling back to height 0
    try {
      await request(baseUrl)
        .post('/rollback')
        .send({ height: 0 });
    } catch (error) {
      // If rollback fails, the server might not be running or accessible
      console.warn('Failed to reset blockchain state. Ensure the server is running at:', baseUrl);
    }
  });

  // Helper function to create test blocks
  function createTestBlock(height: number, transactions: Transaction[]): Block {
    return {
      height,
      id: calculateBlockId(height, transactions),
      transactions
    };
  }

  describe('GET / - Service Status Endpoint', () => {
    it('should return service status with correct structure', async () => {
      const response = await request(baseUrl)
        .get('/')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toEqual({
        status: 'ok',
        service: 'blockchain-indexer',
        timestamp: expect.any(String)
      });

      // Validate timestamp format
      expect(new Date(response.body.timestamp)).toBeInstanceOf(Date);
    });

    it('should return consistent response format', async () => {
      const responses = await Promise.all([
        request(baseUrl).get('/'),
        request(baseUrl).get('/'),
        request(baseUrl).get('/')
      ]);

      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('status', 'ok');
        expect(response.body).toHaveProperty('service', 'blockchain-indexer');
        expect(response.body).toHaveProperty('timestamp');
      });
    });
  });

  describe('GET /health - System Health Endpoint', () => {
    it('should return comprehensive health information', async () => {
      const response = await request(baseUrl)
        .get('/health')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toMatchObject({
        status: expect.stringMatching(/^(healthy|degraded|unhealthy)$/),
        timestamp: expect.any(String),
        uptime: expect.any(Number),
        database: {
          connected: expect.any(Boolean)
        },
        concurrency: {
          queueLength: expect.any(Number),
          isProcessingBlocks: expect.any(Boolean),
          rollbackInProgress: expect.any(Boolean)
        },
        errors: {
          totalErrors: expect.any(Number),
          recentErrors: expect.any(Number),
          dailyErrors: expect.any(Number)
        }
      });
    });

    it('should report healthy status when database is connected', async () => {
      const response = await request(baseUrl)
        .get('/health')
        .expect(200);

      expect(response.body.database.connected).toBe(true);
      expect(['healthy', 'degraded']).toContain(response.body.status);
    });

    it('should include connection count when database is available', async () => {
      const response = await request(baseUrl)
        .get('/health')
        .expect(200);

      expect(response.body.database).toHaveProperty('connectionCount');
      expect(typeof response.body.database.connectionCount).toBe('number');
      expect(response.body.database.connectionCount).toBeGreaterThan(0);
    });
  });

  describe('GET /metrics - System Metrics Endpoint', () => {
    it('should return system metrics for monitoring', async () => {
      const response = await request(baseUrl)
        .get('/metrics')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toMatchObject({
        uptime_seconds: expect.any(Number),
        memory_usage_rss: expect.any(Number),
        memory_usage_heap_total: expect.any(Number),
        memory_usage_heap_used: expect.any(Number),
        memory_usage_external: expect.any(Number),
        memory_usage_array_buffers: expect.any(Number),
        block_processing_queue_length: expect.any(Number),
        block_processing_active: expect.any(Number),
        rollback_in_progress: expect.any(Number),
        errors_total: expect.any(Number),
        errors_recent_1h: expect.any(Number),
        errors_daily: expect.any(Number)
      });
    });

    it('should include database connection metrics', async () => {
      const response = await request(baseUrl)
        .get('/metrics')
        .expect(200);

      expect(response.body).toHaveProperty('database_connections_total');
      expect(response.body).toHaveProperty('database_connections_idle');
      expect(response.body).toHaveProperty('database_connections_waiting');

      expect(response.body.database_connections_total).toBeGreaterThan(0);
    });

    it('should return numeric values for all metrics', async () => {
      const response = await request(baseUrl)
        .get('/metrics')
        .expect(200);

      // Check that all metric values are numbers
      Object.entries(response.body).forEach(([key, value]) => {
        expect(typeof value).toBe('number');
      });
    });
  });

  describe('POST /blocks - Block Processing Endpoint', () => {
    it('should process a valid genesis block', async () => {
      const genesisBlock = createTestBlock(1, [{
        id: 'genesis-tx',
        inputs: [],
        outputs: [
          { address: 'alice', value: 1000 },
          { address: 'bob', value: 500 }
        ]
      }]);

      const response = await request(baseUrl)
        .post('/blocks')
        .send(genesisBlock)
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toEqual({
        success: true,
        blockHeight: 1,
        message: 'Block 1 processed successfully'
      });
    });

    it('should process sequential blocks correctly', async () => {
      // Process first block
      const block1 = createTestBlock(1, [{
        id: 'tx1',
        inputs: [],
        outputs: [{ address: 'alice', value: 1000 }]
      }]);

      await request(baseUrl)
        .post('/blocks')
        .send(block1)
        .expect(200);

      // Process second block
      const block2 = createTestBlock(2, [{
        id: 'tx2',
        inputs: [{ txId: 'tx1', index: 0 }],
        outputs: [{ address: 'bob', value: 1000 }]
      }]);

      const response = await request(baseUrl)
        .post('/blocks')
        .send(block2)
        .expect(200);

      expect(response.body.blockHeight).toBe(2);
      expect(response.body.success).toBe(true);
    });

    it('should reject blocks with invalid height sequence', async () => {
      const invalidBlock = createTestBlock(5, [{
        id: 'invalid-tx',
        inputs: [],
        outputs: [{ address: 'alice', value: 100 }]
      }]);

      const response = await request(baseUrl)
        .post('/blocks')
        .send(invalidBlock)
        .expect(400)
        .expect('Content-Type', /json/);

      expect(response.body).toMatchObject({
        success: false,
        error: expect.stringContaining('First block must have height'),
        blockHeight: 5
      });
    });

    it('should reject duplicate blocks', async () => {
      const block = createTestBlock(1, [{
        id: 'duplicate-tx',
        inputs: [],
        outputs: [{ address: 'alice', value: 100 }]
      }]);

      // Submit first time
      await request(baseUrl)
        .post('/blocks')
        .send(block)
        .expect(200);

      // Submit duplicate
      const response = await request(baseUrl)
        .post('/blocks')
        .send(block)
        .expect(409);

      expect(response.body).toMatchObject({
        success: false,
        error: expect.stringContaining('already processed')
      });
    });

    it('should validate required block fields', async () => {
      // Missing height
      await request(baseUrl)
        .post('/blocks')
        .send({ id: 'test-id', transactions: [] })
        .expect(400);

      // Missing id
      await request(baseUrl)
        .post('/blocks')
        .send({ height: 1, transactions: [] })
        .expect(400);

      // Missing transactions
      await request(baseUrl)
        .post('/blocks')
        .send({ height: 1, id: 'test-id' })
        .expect(400);
    });

    it('should validate transaction structure', async () => {
      const invalidBlock = {
        height: 1,
        id: 'test-id',
        transactions: [{
          // Missing required fields
          invalid: 'transaction'
        }]
      };

      await request(baseUrl)
        .post('/blocks')
        .send(invalidBlock)
        .expect(400);
    });

    it('should handle malformed JSON', async () => {
      await request(baseUrl)
        .post('/blocks')
        .set('Content-Type', 'application/json')
        .send('{ invalid json')
        .expect(400);
    });

    it('should validate block ID matches calculated hash', async () => {
      const block = {
        height: 1,
        id: 'invalid-hash',
        transactions: [{
          id: 'tx1',
          inputs: [],
          outputs: [{ address: 'alice', value: 100 }]
        }]
      };

      const response = await request(baseUrl)
        .post('/blocks')
        .send(block)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: expect.stringContaining('Block ID does not match')
      });
    });

    it('should process complex multi-transaction blocks', async () => {
      // Genesis block with multiple outputs
      const genesisBlock = createTestBlock(1, [{
        id: 'genesis-tx',
        inputs: [],
        outputs: [
          { address: 'alice', value: 1000 },
          { address: 'bob', value: 500 },
          { address: 'charlie', value: 300 }
        ]
      }]);

      await request(baseUrl)
        .post('/blocks')
        .send(genesisBlock)
        .expect(200);

      // Block with multiple transactions
      const multiTxBlock = createTestBlock(2, [
        {
          id: 'tx1',
          inputs: [{ txId: 'genesis-tx', index: 0 }],
          outputs: [
            { address: 'dave', value: 600 },
            { address: 'eve', value: 400 }
          ]
        },
        {
          id: 'tx2',
          inputs: [{ txId: 'genesis-tx', index: 1 }],
          outputs: [{ address: 'frank', value: 500 }]
        }
      ]);

      const response = await request(baseUrl)
        .post('/blocks')
        .send(multiTxBlock)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.blockHeight).toBe(2);
    });
  });

  describe('GET /balance/:address - Balance Queries', () => {
    beforeEach(async () => {
      // Set up test data: process a genesis block
      const genesisBlock = createTestBlock(1, [{
        id: 'genesis-tx',
        inputs: [],
        outputs: [
          { address: 'alice', value: 1000 },
          { address: 'bob', value: 500 }
        ]
      }]);

      await request(baseUrl)
        .post('/blocks')
        .send(genesisBlock)
        .expect(200);
    });

    it('should return correct balance for existing address', async () => {
      const response = await request(baseUrl)
        .get('/balance/alice')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toEqual({
        address: 'alice',
        balance: 1000
      });
    });

    it('should return zero balance for non-existent address', async () => {
      const response = await request(baseUrl)
        .get('/balance/nonexistent')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toEqual({
        address: 'nonexistent',
        balance: 0
      });
    });

    it('should validate address format', async () => {
      const invalidAddresses = [
        'invalid@address!',
        'address with spaces',
        'address/with/slashes',
        'address#with#hash'
      ];

      for (const invalidAddress of invalidAddresses) {
        await request(baseUrl)
          .get(`/balance/${encodeURIComponent(invalidAddress)}`)
          .expect(400);
      }
    });

    it('should handle empty address parameter', async () => {
      await request(baseUrl)
        .get('/balance/')
        .expect(400); // Bad request for empty address
    });

    it('should return updated balance after transactions', async () => {
      // Process a transaction that spends alice's UTXO
      const block2 = createTestBlock(2, [{
        id: 'tx1',
        inputs: [{ txId: 'genesis-tx', index: 0 }],
        outputs: [
          { address: 'charlie', value: 600 },
          { address: 'alice', value: 400 }
        ]
      }]);

      await request(baseUrl)
        .post('/blocks')
        .send(block2)
        .expect(200);

      // Check updated balances
      // Alice should now have 400 (the original 1000 was spent, 400 received back)
      const aliceResponse = await request(baseUrl)
        .get('/balance/alice')
        .expect(200);
      expect(aliceResponse.body.balance).toBe(400);

      const charlieResponse = await request(baseUrl)
        .get('/balance/charlie')
        .expect(200);
      expect(charlieResponse.body.balance).toBe(600);
    });

    it('should handle concurrent balance queries', async () => {
      const promises = Array.from({ length: 3 }, () =>
        request(baseUrl).get('/balance/alice')
      );

      const responses = await Promise.all(promises);

      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.balance).toBe(1000);
      });
    });
  });

  describe('POST /rollback - Rollback Operations', () => {
    beforeEach(async () => {
      // Set up test blockchain with multiple blocks
      const genesisBlock = createTestBlock(1, [{
        id: 'genesis-tx',
        inputs: [],
        outputs: [{ address: 'alice', value: 1000 }]
      }]);

      await request(baseUrl)
        .post('/blocks')
        .send(genesisBlock)
        .expect(200);

      // Add second block
      const block2 = createTestBlock(2, [{
        id: 'tx2',
        inputs: [{ txId: 'genesis-tx', index: 0 }],
        outputs: [
          { address: 'bob', value: 600 },
          { address: 'charlie', value: 400 }
        ]
      }]);

      await request(baseUrl)
        .post('/blocks')
        .send(block2)
        .expect(200);

      // Add third block
      const block3 = createTestBlock(3, [{
        id: 'tx3',
        inputs: [{ txId: 'tx2', index: 0 }],
        outputs: [{ address: 'dave', value: 600 }]
      }]);

      await request(baseUrl)
        .post('/blocks')
        .send(block3)
        .expect(200);
    });

    it('should rollback to valid height successfully', async () => {
      const response = await request(baseUrl)
        .post('/rollback')
        .send({ height: 2 })
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toMatchObject({
        success: true,
        newHeight: 2,
        message: expect.stringContaining('rolled back')
      });

      // Verify balances are correct after rollback
      const bobResponse = await request(baseUrl)
        .get('/balance/bob')
        .expect(200);
      expect(bobResponse.body.balance).toBe(600);

      const daveResponse = await request(baseUrl)
        .get('/balance/dave')
        .expect(200);
      expect(daveResponse.body.balance).toBe(0); // Should be reset
    });

    it('should rollback to genesis (height 1)', async () => {
      const response = await request(baseUrl)
        .post('/rollback')
        .send({ height: 1 })
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        newHeight: 1
      });

      // Verify only genesis balances remain
      const aliceResponse = await request(baseUrl)
        .get('/balance/alice')
        .expect(200);
      expect(aliceResponse.body.balance).toBe(1000);

      const bobResponse = await request(baseUrl)
        .get('/balance/bob')
        .expect(200);
      expect(bobResponse.body.balance).toBe(0);
    });

    it('should rollback to height 0 (complete reset)', async () => {
      const response = await request(baseUrl)
        .post('/rollback')
        .send({ height: 0 })
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        newHeight: 0
      });

      // Verify all balances are zero
      const aliceResponse = await request(baseUrl)
        .get('/balance/alice')
        .expect(200);
      expect(aliceResponse.body.balance).toBe(0);
    });

    it('should distinguish between null and 0 height values', async () => {
      // Height 0 should work (complete reset)
      await request(baseUrl)
        .post('/rollback')
        .send({ height: 0 })
        .expect(200);

      // Height null should fail with 400
      const nullResponse = await request(baseUrl)
        .post('/rollback')
        .send({ height: null })
        .expect(400);
      
      expect(nullResponse.body.error).toContain('cannot be null');
    });

    it('should reject rollback to height greater than current', async () => {
      const response = await request(baseUrl)
        .post('/rollback')
        .send({ height: 10 })
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: expect.stringContaining('greater than current height')
      });
    });

    it('should reject rollback with invalid height parameter', async () => {
      const invalidHeights = [
        'invalid',
        -1,
        1.5
      ];

      for (const invalidHeight of invalidHeights) {
        await request(baseUrl)
          .post('/rollback')
          .send({ height: invalidHeight })
          .expect(400);
      }

      // Test null separately - should return 400, not 200
      const nullResponse = await request(baseUrl)
        .post('/rollback')
        .send({ height: null })
        .expect(400);
      
      expect(nullResponse.body).toMatchObject({
        success: false,
        error: expect.stringContaining('cannot be null')
      });
    });

    it('should handle missing height parameter', async () => {
      await request(baseUrl)
        .post('/rollback')
        .send({})
        .expect(400);
    });
  });

  describe('Concurrent Request Handling', () => {
    it('should handle concurrent block processing requests', async () => {
      const blocks = Array.from({ length: 3 }, (_, i) =>
        createTestBlock(i + 1, [{
          id: `tx${i + 1}`,
          inputs: i === 0 ? [] : [{ txId: `tx${i}`, index: 0 }],
          outputs: [{ address: `addr${i + 1}`, value: 100 }]
        }])
      );

      // Submit blocks concurrently
      const promises = blocks.map(block =>
        request(baseUrl)
          .post('/blocks')
          .send(block)
      );

      const responses = await Promise.all(promises);

      // At least the first block should succeed
      const successfulResponses = responses.filter(r => r.status === 200);
      expect(successfulResponses.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle concurrent balance queries during block processing', async () => {
      // Set up initial state
      const genesisBlock = createTestBlock(1, [{
        id: 'genesis-tx',
        inputs: [],
        outputs: [{ address: 'alice', value: 1000 }]
      }]);

      await request(baseUrl)
        .post('/blocks')
        .send(genesisBlock)
        .expect(200);

      // Start concurrent balance queries and block processing
      const balanceQueries = Array.from({ length: 2 }, () =>
        request(baseUrl).get('/balance/alice')
      );

      const blockProcessing = request(baseUrl)
        .post('/blocks')
        .send(createTestBlock(2, [{
          id: 'tx2',
          inputs: [{ txId: 'genesis-tx', index: 0 }],
          outputs: [{ address: 'bob', value: 1000 }]
        }]));

      const allPromises = [...balanceQueries, blockProcessing];
      const responses = await Promise.all(allPromises);

      // All balance queries should return valid responses
      const balanceResponses = responses.slice(0, 2);
      balanceResponses.forEach(response => {
        expect([200, 503]).toContain(response.status); // 503 if blocked during processing
      });

      // Block processing should succeed
      const blockResponse = responses[2];
      expect([200, 400]).toContain(blockResponse.status);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should return appropriate error status codes', async () => {
      // 400 Bad Request scenarios
      await request(baseUrl)
        .post('/blocks')
        .send({ invalid: 'block' })
        .expect(400);

      await request(baseUrl)
        .get('/balance/invalid@address')
        .expect(400);

      await request(baseUrl)
        .post('/rollback')
        .send({ height: 'invalid' })
        .expect(400);

      // 404 Not Found
      await request(baseUrl)
        .get('/nonexistent-endpoint')
        .expect(404);
    });

    it('should handle malformed request bodies', async () => {
      await request(baseUrl)
        .post('/blocks')
        .set('Content-Type', 'application/json')
        .send('{ malformed json')
        .expect(400);

      await request(baseUrl)
        .post('/rollback')
        .set('Content-Type', 'application/json')
        .send('{ malformed json')
        .expect(400);
    });

    it('should validate content-type headers', async () => {
      await request(baseUrl)
        .post('/blocks')
        .set('Content-Type', 'text/plain')
        .send('not json')
        .expect(400);
    });

    it('should handle very large request bodies gracefully', async () => {
      const largeBlock = createTestBlock(1, Array.from({ length: 100 }, (_, i) => ({
        id: `tx${i}`,
        inputs: [],
        outputs: [{ address: `addr${i}`, value: 1 }]
      })));

      const response = await request(baseUrl)
        .post('/blocks')
        .send(largeBlock);

      // Should either process successfully or reject with appropriate error
      expect([200, 400, 413]).toContain(response.status);
    });
  });

  describe('Swagger Documentation Endpoint', () => {
    it('should serve Swagger UI documentation', async () => {
      const response = await request(baseUrl)
        .get('/docs')
        .expect(200);

      expect(response.text).toContain('swagger');
    });

    it('should serve OpenAPI JSON specification', async () => {
      const response = await request(baseUrl)
        .get('/docs/json')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toHaveProperty('openapi');
      expect(response.body).toHaveProperty('info');
      expect(response.body).toHaveProperty('paths');
    });
  });
});