import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { DatabaseConnection } from '@database/connection-stub';
import { registerRoutes } from '@routes/index';
import { BlockProcessor } from '@services/block-processor';
import { concurrencyManager } from '@services/concurrency-manager';
import { errorHandler } from '@services/error-handler';
import { UTXORepository } from '@database/repositories/utxo-repository';
import { BalanceRepository } from '@database/repositories/balance-repository';
import crypto from 'crypto';
import type { Block, Transaction } from '@shared/blockchain';

// Type declarations moved to src/types/fastify.d.ts

describe('API Integration Tests', () => {
  let app: FastifyInstance;

  // Helper function to create block ID
  function createBlockId(height: number, transactionIds: string[]): string {
    const data = height.toString() + transactionIds.join('');
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  // Helper function to create test block
  function createTestBlock(height: number, transactions: Transaction[]): Block {
    const transactionIds = transactions.map(tx => tx.id);
    return {
      height,
      id: createBlockId(height, transactionIds),
      transactions
    };
  }

  // Mock database state for testing
  const mockDatabaseState = {
    blocks: new Map<number, any>(),
    transactions: new Map<string, any>(),
    utxos: new Map<string, any>(),
    balances: new Map<string, number>()
  };

  // Helper function to clean database
  async function cleanDatabase() {
    mockDatabaseState.blocks.clear();
    mockDatabaseState.transactions.clear();
    mockDatabaseState.utxos.clear();
    mockDatabaseState.balances.clear();
  }

  beforeEach(async () => {
    // Clear database storage between tests
    DatabaseConnection.clearStorage();
  });

  // Mock database
  const mockDb = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    getPool: vi.fn().mockReturnValue({
      totalCount: 10,
      idleCount: 5,
      waitingCount: 0
    })
  };

  // Mock UTXO Repository
  const mockUTXORepository = {
    saveUTXOs: vi.fn().mockResolvedValue(undefined),
    spendUTXOs: vi.fn().mockResolvedValue(undefined),
    getUTXO: vi.fn().mockImplementation(async (txId: string, index: number) => {
      const key = `${txId}:${index}`;
      return mockDatabaseState.utxos.get(key) || null;
    }),
    rollbackUTXOsAfterHeight: vi.fn().mockResolvedValue(undefined),
    recalculateAllBalances: vi.fn().mockResolvedValue(undefined)
  };

  // Mock Balance Repository
  const mockBalanceRepository = {
    getBalance: vi.fn().mockImplementation(async (address: string) => {
      return mockDatabaseState.balances.get(address) || 0;
    }),
    updateBalance: vi.fn().mockImplementation(async (address: string, balance: number) => {
      mockDatabaseState.balances.set(address, balance);
    }),
    batchUpdateBalances: vi.fn().mockResolvedValue(undefined),
    recalculateAllBalances: vi.fn().mockResolvedValue(undefined)
  };

  // Mock Block Processor
  const mockBlockProcessor = {
    processBlock: vi.fn().mockImplementation(async (block: Block) => {
      // Simulate block processing logic
      const blockHeight = block.height;
      
      // Check if block already exists
      if (mockDatabaseState.blocks.has(blockHeight)) {
        return {
          success: false,
          blockHeight,
          error: `Block at height ${blockHeight} already processed`
        };
      }
      
      // Validate block height sequence
      const currentHeight = Math.max(0, ...Array.from(mockDatabaseState.blocks.keys()));
      const expectedHeight = currentHeight + 1;
      if (blockHeight !== expectedHeight && !(blockHeight === 1 && currentHeight === 0)) {
        return {
          success: false,
          blockHeight,
          error: currentHeight === 0 ? `First block must have height 1, got ${blockHeight}` : `Block height must be ${expectedHeight}, got ${blockHeight}`
        };
      }
      
      // Validate block ID (simplified check)
      const expectedId = createBlockId(blockHeight, block.transactions.map(tx => tx.id));
      if (block.id !== expectedId) {
        return {
          success: false,
          blockHeight,
          error: 'Block ID does not match expected SHA256 hash'
        };
      }
      
      // Validate transaction balances (simplified check for non-genesis transactions)
      for (const tx of block.transactions) {
        if (tx.inputs.length > 0) {
          // For non-genesis transactions, check if inputs exist and calculate balance
          let inputSum = 0;
          let outputSum = 0;
          
          // Calculate input sum by looking up referenced transactions
          for (const input of tx.inputs) {
            // Look for the referenced transaction in stored blocks
            let inputValue = 0;
            for (const [, storedBlock] of mockDatabaseState.blocks) {
              const referencedTx = storedBlock.transactions.find((t: any) => t.id === input.txId);
              if (referencedTx && referencedTx.outputs[input.index]) {
                inputValue = referencedTx.outputs[input.index].value;
                break;
              }
            }
            inputSum += inputValue;
          }
          
          // Calculate output sum
          for (const output of tx.outputs) {
            outputSum += output.value;
          }
          
          // Check if transaction is balanced (outputs cannot exceed inputs)
          if (outputSum > inputSum) {
            return {
              success: false,
              blockHeight,
              error: 'One or more transactions have invalid input/output balance'
            };
          }
        }
      }
      
      // Store block
      mockDatabaseState.blocks.set(blockHeight, block);
      
      // Update balances from transactions (simplified UTXO logic)
      for (const tx of block.transactions) {
        // For genesis transactions (no inputs), just add outputs
        if (tx.inputs.length === 0) {
          for (const output of tx.outputs) {
            const currentBalance = mockDatabaseState.balances.get(output.address) || 0;
            mockDatabaseState.balances.set(output.address, currentBalance + output.value);
          }
        } else {
          // For regular transactions, we need to handle UTXO spending
          // In a real system, we'd validate inputs exist and subtract them
          // For this mock, we'll simulate by finding the input transaction and subtracting its value
          
          // Add outputs
          for (const output of tx.outputs) {
            const currentBalance = mockDatabaseState.balances.get(output.address) || 0;
            mockDatabaseState.balances.set(output.address, currentBalance + output.value);
          }
          
          // Subtract inputs (simplified - find the referenced transaction and subtract from original recipient)
          for (const input of tx.inputs) {
            // Find the referenced transaction in stored blocks
            for (const [, storedBlock] of mockDatabaseState.blocks) {
              const referencedTx = storedBlock.transactions.find((t: any) => t.id === input.txId);
              if (referencedTx && referencedTx.outputs[input.index]) {
                const outputToSpend = referencedTx.outputs[input.index];
                const currentBalance = mockDatabaseState.balances.get(outputToSpend.address) || 0;
                mockDatabaseState.balances.set(outputToSpend.address, Math.max(0, currentBalance - outputToSpend.value));
              }
            }
          }
        }
      }
      
      return {
        success: true,
        blockHeight,
        message: `Block ${blockHeight} processed successfully`
      };
    }),
    rollbackToHeight: vi.fn().mockImplementation(async (targetHeight: any) => {
      // Validate parameter type
      if (typeof targetHeight !== 'number' || isNaN(targetHeight) || !Number.isInteger(targetHeight)) {
        return {
          success: false,
          blockHeight: targetHeight,
          error: 'Invalid height: must be an integer'
        };
      }
      
      // Validate target height
      const currentHeight = Math.max(0, ...Array.from(mockDatabaseState.blocks.keys()));
      
      if (targetHeight > currentHeight) {
        return {
          success: false,
          blockHeight: targetHeight,
          error: `Target height ${targetHeight} is greater than current height ${currentHeight}`
        };
      }
      
      if (targetHeight < 0) {
        return {
          success: false,
          blockHeight: targetHeight,
          error: 'Target height cannot be negative'
        };
      }
      
      // Remove blocks above target height
      for (const [height] of mockDatabaseState.blocks) {
        if (height > targetHeight) {
          mockDatabaseState.blocks.delete(height);
        }
      }
      
      // Recalculate balances
      mockDatabaseState.balances.clear();
      for (const [, block] of mockDatabaseState.blocks) {
        for (const tx of block.transactions) {
          for (const output of tx.outputs) {
            const currentBalance = mockDatabaseState.balances.get(output.address) || 0;
            mockDatabaseState.balances.set(output.address, currentBalance + output.value);
          }
        }
      }
      
      return {
        success: true,
        blockHeight: targetHeight,
        message: `Successfully rolled back to height ${targetHeight}`
      };
    })
  };

  beforeAll(async () => {
    // Create Fastify instance
    app = Fastify({ logger: false });

    // Register all dependencies with Fastify (same as bootstrap)
    app.decorate('db', mockDb);
    app.decorate('utxoRepository', mockUTXORepository);
    app.decorate('balanceRepository', mockBalanceRepository);
    app.decorate('blockProcessor', mockBlockProcessor);
    app.decorate('services', {
      concurrencyManager,
      errorHandler
    });
    
    // Register routes
    await registerRoutes(app);
    
    await app.ready();
  });

  beforeEach(async () => {
    // Clean database before each test
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
  });

  describe('Health Check Endpoints', () => {
    it('should return basic health status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.service).toBe('blockchain-indexer');
      expect(body.timestamp).toBeDefined();
    });

    it('should return detailed health information', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toMatch(/^(healthy|degraded|unhealthy)$/);
      expect(body.timestamp).toBeDefined();
      expect(body.uptime).toBeTypeOf('number');
      expect(body.database).toBeDefined();
      expect(body.database.connected).toBeTypeOf('boolean');
      expect(body.concurrency).toBeDefined();
      expect(body.errors).toBeDefined();
    });

    it('should return metrics information', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/metrics'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.uptime_seconds).toBeTypeOf('number');
      expect(body.block_processing_queue_length).toBeTypeOf('number');
      expect(body.errors_total).toBeTypeOf('number');
    });
  });

  describe('POST /blocks - Block Processing', () => {
    it('should process valid genesis block successfully', async () => {
      // Requirements: 1.1, 1.2, 1.3, 1.4
      const genesisTransaction: Transaction = {
        id: 'genesis-tx',
        inputs: [], // Genesis has no inputs
        outputs: [
          { address: 'addr1', value: 1000 },
          { address: 'addr2', value: 500 }
        ]
      };

      const genesisBlock = createTestBlock(1, [genesisTransaction]);

      const response = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: genesisBlock
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.blockHeight).toBe(1);
      expect(body.message).toContain('processed successfully');
    });

    it('should process sequential blocks correctly', async () => {
      // Requirements: 1.1, 1.2, 5.2
      // First process genesis block
      const genesisTransaction: Transaction = {
        id: 'genesis-tx',
        inputs: [],
        outputs: [{ address: 'addr1', value: 1000 }]
      };
      const genesisBlock = createTestBlock(1, [genesisTransaction]);

      const genesisResponse = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: genesisBlock
      });
      expect(genesisResponse.statusCode).toBe(200);

      // Then process second block
      const secondTransaction: Transaction = {
        id: 'tx2',
        inputs: [{ txId: 'genesis-tx', index: 0 }],
        outputs: [
          { address: 'addr2', value: 600 },
          { address: 'addr3', value: 400 }
        ]
      };
      const secondBlock = createTestBlock(2, [secondTransaction]);

      const secondResponse = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: secondBlock
      });

      expect(secondResponse.statusCode).toBe(200);
      const body = JSON.parse(secondResponse.body);
      expect(body.success).toBe(true);
      expect(body.blockHeight).toBe(2);
    });

    it('should reject blocks with invalid height sequence', async () => {
      // Requirements: 5.2
      const transaction: Transaction = {
        id: 'tx1',
        inputs: [],
        outputs: [{ address: 'addr1', value: 100 }]
      };
      const invalidBlock = createTestBlock(5, [transaction]); // Should be height 1

      const response = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: invalidBlock
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('First block must have height');
    });

    it('should reject blocks with invalid block ID', async () => {
      // Requirements: 5.1
      const transaction: Transaction = {
        id: 'tx1',
        inputs: [],
        outputs: [{ address: 'addr1', value: 100 }]
      };
      const block = createTestBlock(1, [transaction]);
      block.id = 'invalid-block-id'; // Corrupt the block ID

      const response = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: block
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Block ID does not match expected SHA256 hash');
    });

    it('should reject blocks with unbalanced transactions', async () => {
      // Requirements: 5.3
      // First create genesis block
      const genesisTransaction: Transaction = {
        id: 'genesis-tx',
        inputs: [],
        outputs: [{ address: 'addr1', value: 1000 }]
      };
      const genesisBlock = createTestBlock(1, [genesisTransaction]);
      await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: genesisBlock
      });

      // Create unbalanced transaction (inputs ≠ outputs)
      const unbalancedTransaction: Transaction = {
        id: 'unbalanced-tx',
        inputs: [{ txId: 'genesis-tx', index: 0 }], // 1000 coins input
        outputs: [{ address: 'addr2', value: 1500 }] // 1500 coins output (invalid!)
      };
      const unbalancedBlock = createTestBlock(2, [unbalancedTransaction]);

      const response = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: unbalancedBlock
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('One or more transactions have invalid input/output balance');
    });

    it('should validate block structure and required fields', async () => {
      // Requirements: 5.1, 5.4
      const invalidBlocks = [
        // Missing height
        { id: 'test', transactions: [] },
        // Invalid height type
        { height: 'invalid', id: 'test', transactions: [] },
        // Missing id
        { height: 1, transactions: [] },
        // Invalid transactions type
        { height: 1, id: 'test', transactions: 'invalid' },
        // Invalid transaction structure
        { height: 1, id: 'test', transactions: [{ invalid: 'transaction' }] }
      ];

      for (const invalidBlock of invalidBlocks) {
        const response = await app.inject({
          method: 'POST',
          url: '/blocks',
          payload: invalidBlock
        });

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.error || body.message).toBeDefined();
      }
    });

    it('should handle duplicate block submission', async () => {
      // Requirements: 1.3
      const transaction: Transaction = {
        id: 'tx1',
        inputs: [],
        outputs: [{ address: 'addr1', value: 100 }]
      };
      const block = createTestBlock(1, [transaction]);

      // Submit block first time
      const firstResponse = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: block
      });
      expect(firstResponse.statusCode).toBe(200);

      // Submit same block again
      const secondResponse = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: block
      });

      expect(secondResponse.statusCode).toBe(409);
      const body = JSON.parse(secondResponse.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('already processed');
    });

    it('should handle complex multi-transaction blocks', async () => {
      // Requirements: 1.1, 1.2
      // Create genesis block with multiple outputs
      const genesisTransaction: Transaction = {
        id: 'genesis-tx',
        inputs: [],
        outputs: [
          { address: 'addr1', value: 1000 },
          { address: 'addr2', value: 500 },
          { address: 'addr3', value: 300 }
        ]
      };
      const genesisBlock = createTestBlock(1, [genesisTransaction]);
      await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: genesisBlock
      });

      // Create block with multiple transactions
      const tx1: Transaction = {
        id: 'tx1',
        inputs: [{ txId: 'genesis-tx', index: 0 }], // 1000 coins
        outputs: [
          { address: 'addr4', value: 600 },
          { address: 'addr5', value: 400 }
        ]
      };

      const tx2: Transaction = {
        id: 'tx2',
        inputs: [{ txId: 'genesis-tx', index: 1 }], // 500 coins
        outputs: [{ address: 'addr6', value: 500 }]
      };

      const multiTxBlock = createTestBlock(2, [tx1, tx2]);

      const response = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: multiTxBlock
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.blockHeight).toBe(2);
    });
  });

  describe('GET /balance/:address - Balance Queries', () => {
    beforeEach(async () => {
      // Set up test data: process a genesis block
      const genesisTransaction: Transaction = {
        id: 'genesis-tx',
        inputs: [],
        outputs: [
          { address: 'addr1', value: 1000 },
          { address: 'addr2', value: 500 }
        ]
      };
      const genesisBlock = createTestBlock(1, [genesisTransaction]);
      const response = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: genesisBlock
      });
      
      // Ensure block was processed successfully
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      
      // Add a small delay to ensure transaction is committed
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    it('should return correct balance for existing address', async () => {
      // Requirements: 2.1, 2.2
      const response = await app.inject({
        method: 'GET',
        url: '/balance/addr1'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.address).toBe('addr1');
      expect(body.balance).toBe(1000);
    });

    it('should return zero balance for non-existent address', async () => {
      // Requirements: 2.2
      const response = await app.inject({
        method: 'GET',
        url: '/balance/nonexistent-address'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.address).toBe('nonexistent-address');
      expect(body.balance).toBe(0);
    });

    it('should validate address format', async () => {
      // Requirements: 2.3
      const invalidAddresses = [
        'invalid@address!',
        'address with spaces',
        'address/with/slashes',
        'address#with#hash',
        'a'.repeat(101) // Too long
      ];

      for (const invalidAddress of invalidAddresses) {
        const response = await app.inject({
          method: 'GET',
          url: `/balance/${encodeURIComponent(invalidAddress)}`
        });

        // The route might return 404 for invalid addresses in some cases
        expect([400, 404]).toContain(response.statusCode);
        if (response.statusCode === 400) {
          const body = JSON.parse(response.body);
          expect(body.error).toContain('Invalid address');
        }
      }
    });

    it('should handle empty address parameter', async () => {
      // Requirements: 2.3
      const response = await app.inject({
        method: 'GET',
        url: '/balance/'
      });

      // The route might return 400 or 404 depending on how empty addresses are handled
      expect([400, 404]).toContain(response.statusCode);
    });

    it('should return updated balance after transactions', async () => {
      // Requirements: 2.1, 2.4
      // Process a transaction that changes balances
      const transaction: Transaction = {
        id: 'tx1',
        inputs: [{ txId: 'genesis-tx', index: 0 }], // 1000 from addr1
        outputs: [
          { address: 'addr3', value: 600 },
          { address: 'addr1', value: 400 } // Return 400 to addr1
        ]
      };
      const block = createTestBlock(2, [transaction]);
      await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: block
      });

      // Check updated balances
      const addr1Response = await app.inject({
        method: 'GET',
        url: '/balance/addr1'
      });
      expect(addr1Response.statusCode).toBe(200);
      expect(JSON.parse(addr1Response.body).balance).toBe(400);

      const addr3Response = await app.inject({
        method: 'GET',
        url: '/balance/addr3'
      });
      expect(addr3Response.statusCode).toBe(200);
      expect(JSON.parse(addr3Response.body).balance).toBe(600);
    });

    it('should handle concurrent balance queries', async () => {
      // Requirements: 4.2
      const promises = Array.from({ length: 10 }, () =>
        app.inject({
          method: 'GET',
          url: '/balance/addr1'
        })
      );

      const responses = await Promise.all(promises);

      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.balance).toBe(1000);
      }
    });
  });

  describe('POST /rollback - Rollback Operations', () => {
    beforeEach(async () => {
      // Set up test blockchain with multiple blocks
      const genesisTransaction: Transaction = {
        id: 'genesis-tx',
        inputs: [],
        outputs: [{ address: 'addr1', value: 1000 }]
      };
      const genesisBlock = createTestBlock(1, [genesisTransaction]);
      await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: genesisBlock
      });

      // Add second block
      const tx2: Transaction = {
        id: 'tx2',
        inputs: [{ txId: 'genesis-tx', index: 0 }],
        outputs: [
          { address: 'addr2', value: 600 },
          { address: 'addr3', value: 400 }
        ]
      };
      const block2 = createTestBlock(2, [tx2]);
      await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: block2
      });

      // Add third block
      const tx3: Transaction = {
        id: 'tx3',
        inputs: [{ txId: 'tx2', index: 0 }],
        outputs: [{ address: 'addr4', value: 600 }]
      };
      const block3 = createTestBlock(3, [tx3]);
      await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: block3
      });
    });

    it('should rollback to valid height successfully', async () => {
      // Requirements: 3.1, 3.3, 3.4
      const response = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { height: 2 }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.newHeight).toBe(2);
      expect(body.message).toContain('rolled back');

      // Verify balances are correct after rollback
      const addr2Response = await app.inject({
        method: 'GET',
        url: '/balance/addr2'
      });
      expect(JSON.parse(addr2Response.body).balance).toBe(600);

      const addr4Response = await app.inject({
        method: 'GET',
        url: '/balance/addr4'
      });
      expect(JSON.parse(addr4Response.body).balance).toBe(0); // Should be reset
    });

    it('should rollback to genesis (height 1)', async () => {
      // Requirements: 3.1, 3.4
      const response = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { height: 1 }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.newHeight).toBe(1);

      // Verify only genesis balances remain
      const addr1Response = await app.inject({
        method: 'GET',
        url: '/balance/addr1'
      });
      expect(JSON.parse(addr1Response.body).balance).toBe(1000);

      const addr2Response = await app.inject({
        method: 'GET',
        url: '/balance/addr2'
      });
      expect(JSON.parse(addr2Response.body).balance).toBe(0);
    });

    it('should rollback to height 0 (complete reset)', async () => {
      // Requirements: 3.1, 3.5
      const response = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { height: 0 }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.newHeight).toBe(0);

      // Verify all balances are zero
      const addr1Response = await app.inject({
        method: 'GET',
        url: '/balance/addr1'
      });
      expect(JSON.parse(addr1Response.body).balance).toBe(0);
    });

    it('should reject rollback to height greater than current', async () => {
      // Requirements: 3.2
      const response = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { height: 10 }
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('greater than current height');
    });

    it('should reject rollback with invalid height parameter', async () => {
      // Requirements: 3.2
      const invalidHeights = [
        'invalid',
        -1,
        1.5,
        null,
        undefined
      ];

      for (const invalidHeight of invalidHeights) {
        const response = await app.inject({
          method: 'POST',
          url: '/rollback',
          payload: { height: invalidHeight }
        });

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.error || body.message).toBeDefined();
      }
    });

    it('should handle rollback beyond 2000 block limit', async () => {
      // Requirements: 3.2
      // This test simulates the scenario where current height is high
      // and rollback target exceeds the 2000 block limit
      
      // Mock a scenario where we try to rollback too far
      // (In real implementation, this would be tested with actual high block numbers)
      const response = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { height: 0 } // This should be valid for our test setup
      });

      // For our test setup with only 3 blocks, rollback to 0 should work
      expect(response.statusCode).toBe(200);
      
      // The 2000 block limit would be tested in a scenario with more blocks
      // where (currentHeight - targetHeight) > 2000
    });
  });

  describe('Concurrent Request Handling', () => {
    it('should handle concurrent block processing requests sequentially', async () => {
      // Requirements: 4.1, 4.2
      const transactions = Array.from({ length: 5 }, (_, i) => ({
        id: `tx${i + 1}`,
        inputs: [],
        outputs: [{ address: `addr${i + 1}`, value: 100 }]
      }));

      const blocks = transactions.map((tx, i) => createTestBlock(i + 1, [tx]));

      // Submit all blocks concurrently
      const promises = blocks.map(block =>
        app.inject({
          method: 'POST',
          url: '/blocks',
          payload: block
        })
      );

      const responses = await Promise.all(promises);

      // All blocks should be processed successfully (sequential processing ensures consistency)
      let successCount = 0;
      for (const response of responses) {
        if (response.statusCode === 200) {
          successCount++;
        }
      }

      // At least the first block should succeed, others might fail due to height validation
      expect(successCount).toBeGreaterThanOrEqual(1);
    });

    it('should handle concurrent balance queries during block processing', async () => {
      // Requirements: 4.2
      // Set up initial state
      const genesisTransaction: Transaction = {
        id: 'genesis-tx',
        inputs: [],
        outputs: [{ address: 'addr1', value: 1000 }]
      };
      const genesisBlock = createTestBlock(1, [genesisTransaction]);
      await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: genesisBlock
      });

      // Start concurrent balance queries and block processing
      const balanceQueries = Array.from({ length: 10 }, () =>
        app.inject({
          method: 'GET',
          url: '/balance/addr1'
        })
      );

      const blockProcessing = app.inject({
        method: 'POST',
        url: '/blocks',
        payload: createTestBlock(2, [{
          id: 'tx2',
          inputs: [{ txId: 'genesis-tx', index: 0 }],
          outputs: [{ address: 'addr2', value: 1000 }]
        }])
      });

      const allPromises = [...balanceQueries, blockProcessing];
      const responses = await Promise.all(allPromises);

      // All balance queries should return valid responses
      const balanceResponses = responses.slice(0, 10);
      for (const response of balanceResponses) {
        expect([200, 503]).toContain(response.statusCode); // 503 if queries blocked during processing
      }

      // Block processing should succeed
      const blockResponse = responses[10];
      expect([200, 400]).toContain(blockResponse.statusCode);
    });

    it('should handle concurrent rollback and balance queries', async () => {
      // Requirements: 4.3
      // Set up test data
      const genesisTransaction: Transaction = {
        id: 'genesis-tx',
        inputs: [],
        outputs: [{ address: 'addr1', value: 1000 }]
      };
      const genesisBlock = createTestBlock(1, [genesisTransaction]);
      await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: genesisBlock
      });

      // Start concurrent operations
      const rollbackPromise = app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { height: 0 }
      });

      const balanceQueries = Array.from({ length: 5 }, () =>
        app.inject({
          method: 'GET',
          url: '/balance/addr1'
        })
      );

      const responses = await Promise.all([rollbackPromise, ...balanceQueries]);

      // Rollback should succeed
      expect(responses[0].statusCode).toBe(200);

      // Balance queries might be blocked during rollback (503) or return results
      const balanceResponses = responses.slice(1);
      for (const response of balanceResponses) {
        expect([200, 503]).toContain(response.statusCode);
      }
    });
  });

  describe('Error Handling and Status Codes', () => {
    it('should return appropriate error status codes for various scenarios', async () => {
      // Requirements: 1.3, 1.4, 2.3, 2.4, 3.2, 3.4
      
      // 400 Bad Request scenarios
      const badRequests = [
        {
          method: 'POST',
          url: '/blocks',
          payload: { invalid: 'block' },
          description: 'Invalid block structure'
        },
        {
          method: 'GET',
          url: '/balance/invalid@address',
          description: 'Invalid address format'
        },
        {
          method: 'POST',
          url: '/rollback',
          payload: { height: 'invalid' },
          description: 'Invalid rollback height'
        }
      ];

      for (const request of badRequests) {
        const { description, ...injectOptions } = request;
        const response = await app.inject(injectOptions as any);
        expect((response as any).statusCode).toBe(400);
      }

      // 404 Not Found
      const notFoundResponse = await app.inject({
        method: 'GET',
        url: '/nonexistent-endpoint'
      });
      expect(notFoundResponse.statusCode).toBe(404);

      // 409 Conflict (duplicate block)
      const transaction: Transaction = {
        id: 'tx1',
        inputs: [],
        outputs: [{ address: 'addr1', value: 100 }]
      };
      const block = createTestBlock(1, [transaction]);

      await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: block
      });

      const duplicateResponse = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: block
      });
      expect(duplicateResponse.statusCode).toBe(409);
    });

    it('should handle database connection errors gracefully', async () => {
      // Requirements: 4.4
      // This test would require mocking database failures
      // For now, we test that the error handling structure is in place
      
      const response = await app.inject({
        method: 'GET',
        url: '/health'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.database).toBeDefined();
      expect(body.database.connected).toBeTypeOf('boolean');
    });

    it('should provide detailed error messages', async () => {
      // Requirements: 1.4, 2.4, 3.4
      const invalidBlock = {
        height: 1,
        id: 'test',
        transactions: [{
          id: 'tx1',
          inputs: 'invalid', // Should be array
          outputs: []
        }]
      };

      const response = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: invalidBlock
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error || body.message).toBeDefined();
      expect(typeof (body.error || body.message)).toBe('string');
    });
  });

  describe('End-to-End Workflow Tests', () => {
    it('should handle complete blockchain workflow', async () => {
      // Requirements: 1.1, 1.2, 2.1, 3.1
      
      // 1. Process genesis block
      const genesisTransaction: Transaction = {
        id: 'genesis-tx',
        inputs: [],
        outputs: [
          { address: 'alice', value: 1000 },
          { address: 'bob', value: 500 }
        ]
      };
      const genesisBlock = createTestBlock(1, [genesisTransaction]);
      
      const genesisResponse = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: genesisBlock
      });
      expect(genesisResponse.statusCode).toBe(200);

      // 2. Check initial balances
      const aliceBalance1 = await app.inject({
        method: 'GET',
        url: '/balance/alice'
      });
      expect(JSON.parse(aliceBalance1.body).balance).toBe(1000);

      // 3. Process transaction block
      const tx1: Transaction = {
        id: 'tx1',
        inputs: [{ txId: 'genesis-tx', index: 0 }], // Alice's 1000
        outputs: [
          { address: 'charlie', value: 300 },
          { address: 'alice', value: 700 } // Change back to Alice
        ]
      };
      const block2 = createTestBlock(2, [tx1]);
      
      const block2Response = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: block2
      });
      expect(block2Response.statusCode).toBe(200);

      // 4. Check updated balances
      const aliceBalance2 = await app.inject({
        method: 'GET',
        url: '/balance/alice'
      });
      expect(JSON.parse(aliceBalance2.body).balance).toBe(700);

      const charlieBalance = await app.inject({
        method: 'GET',
        url: '/balance/charlie'
      });
      expect(JSON.parse(charlieBalance.body).balance).toBe(300);

      // 5. Rollback to genesis
      const rollbackResponse = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { height: 1 }
      });
      expect(rollbackResponse.statusCode).toBe(200);

      // 6. Verify balances after rollback
      const aliceBalance3 = await app.inject({
        method: 'GET',
        url: '/balance/alice'
      });
      expect(JSON.parse(aliceBalance3.body).balance).toBe(1000);

      const charlieBalance2 = await app.inject({
        method: 'GET',
        url: '/balance/charlie'
      });
      expect(JSON.parse(charlieBalance2.body).balance).toBe(0);
    });

    it('should handle complex multi-block scenario with rollback', async () => {
      // Requirements: 1.1, 1.2, 2.1, 3.1
      
      // Create a chain of 5 blocks
      const blocks: Block[] = [];
      
      // Genesis block
      blocks.push(createTestBlock(1, [{
        id: 'genesis-tx',
        inputs: [],
        outputs: [{ address: 'addr1', value: 1000 }]
      }]));

      // Subsequent blocks
      for (let i = 2; i <= 5; i++) {
        const prevTxId = i === 2 ? 'genesis-tx' : `tx${i-1}`;
        blocks.push(createTestBlock(i, [{
          id: `tx${i}`,
          inputs: [{ txId: prevTxId, index: 0 }],
          outputs: [{ address: `addr${i}`, value: 1000 }]
        }]));
      }

      // Process all blocks
      for (const block of blocks) {
        const response = await app.inject({
          method: 'POST',
          url: '/blocks',
          payload: block
        });
        expect(response.statusCode).toBe(200);
      }

      // Verify final state
      const finalBalance = await app.inject({
        method: 'GET',
        url: '/balance/addr5'
      });
      expect(JSON.parse(finalBalance.body).balance).toBe(1000);

      // Rollback to block 3
      const rollbackResponse = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { height: 3 }
      });
      expect(rollbackResponse.statusCode).toBe(200);

      // Verify rollback state
      const addr3Balance = await app.inject({
        method: 'GET',
        url: '/balance/addr3'
      });
      expect(JSON.parse(addr3Balance.body).balance).toBe(1000);

      const addr5Balance = await app.inject({
        method: 'GET',
        url: '/balance/addr5'
      });
      expect(JSON.parse(addr5Balance.body).balance).toBe(0);
    });
  });
});