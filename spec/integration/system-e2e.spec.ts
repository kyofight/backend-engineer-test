import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerRoutes } from '@routes/index';
import { concurrencyManager } from '@services/concurrency-manager';
import { errorHandler } from '@services/error-handler';
import { calculateBlockId } from '@validation/block-validation';
import type { Block, Transaction } from '@shared/blockchain';

/**
 * End-to-End System Tests
 * 
 * These tests validate complete workflows from block submission to balance queries,
 * rollback scenarios with multiple blocks and addresses, and system behavior under
 * various load conditions.
 * 
 * Requirements covered:
 * - 1.1: Block processing with balance updates
 * - 1.2: Atomic transaction processing within blocks
 * - 2.1: Balance query functionality
 * - 3.1: Rollback operations with state restoration
 * - 4.1: Concurrent request handling
 */

// Enhanced mock database state for comprehensive testing
const mockDatabaseState = {
  blocks: new Map<number, Block>(),
  transactions: new Map<string, Transaction>(),
  utxos: new Map<string, { address: string; value: number; txId: string; index: number; isSpent: boolean }>(),
  balances: new Map<string, number>(),
  currentHeight: 0,
  processingQueue: [] as Block[],
  isProcessing: false
};

// Enhanced mock database connection with realistic behavior
const mockDb = {
  query: vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
    // Simulate database query delays
    await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
    return { rows: [] };
  }),
  close: vi.fn().mockResolvedValue(undefined),
  getPool: vi.fn().mockReturnValue({
    totalCount: 10,
    idleCount: 5,
    waitingCount: 0
  })
};

// Enhanced UTXO Repository with realistic UTXO management
const mockUTXORepository = {
  saveUTXOs: vi.fn().mockImplementation(async (outputs: any[], txId: string, blockHeight: number) => {
    for (let i = 0; i < outputs.length; i++) {
      const key = `${txId}:${i}`;
      mockDatabaseState.utxos.set(key, {
        address: outputs[i].address,
        value: outputs[i].value,
        txId,
        index: i,
        isSpent: false
      });
    }
  }),

  spendUTXOs: vi.fn().mockImplementation(async (inputs: any[], spentByTxId: string, blockHeight: number) => {
    for (const input of inputs) {
      const key = `${input.txId}:${input.index}`;
      const utxo = mockDatabaseState.utxos.get(key);
      if (utxo) {
        utxo.isSpent = true;
        mockDatabaseState.utxos.set(key, utxo);
      }
    }
  }),

  getUTXO: vi.fn().mockImplementation(async (txId: string, index: number) => {
    const key = `${txId}:${index}`;
    const utxo = mockDatabaseState.utxos.get(key);
    return utxo && !utxo.isSpent ? utxo : null;
  }),

  rollbackUTXOsAfterHeight: vi.fn().mockImplementation(async (height: number) => {
    // Remove UTXOs created after the target height and unspend UTXOs spent after target height
    const utxosToRemove: string[] = [];
    for (const [key, utxo] of mockDatabaseState.utxos.entries()) {
      // In a real implementation, we'd track creation height
      // For testing, we'll simulate this behavior
      if (mockDatabaseState.currentHeight > height) {
        utxosToRemove.push(key);
      }
    }

    for (const key of utxosToRemove) {
      mockDatabaseState.utxos.delete(key);
    }
  }),

  recalculateAllBalances: vi.fn().mockImplementation(async () => {
    mockDatabaseState.balances.clear();
    for (const [key, utxo] of mockDatabaseState.utxos.entries()) {
      if (!utxo.isSpent) {
        const currentBalance = mockDatabaseState.balances.get(utxo.address) || 0;
        mockDatabaseState.balances.set(utxo.address, currentBalance + utxo.value);
      }
    }
  })
};

// Enhanced Balance Repository with realistic balance management
const mockBalanceRepository = {
  getBalance: vi.fn().mockImplementation(async (address: string) => {
    // Simulate database query delay
    await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
    return mockDatabaseState.balances.get(address) || 0;
  }),

  updateBalance: vi.fn().mockImplementation(async (address: string, balance: number) => {
    mockDatabaseState.balances.set(address, balance);
  }),

  batchUpdateBalances: vi.fn().mockImplementation(async (updates: Array<{ address: string; balance: number }>) => {
    for (const update of updates) {
      mockDatabaseState.balances.set(update.address, update.balance);
    }
  }),

  recalculateAllBalances: vi.fn().mockImplementation(async () => {
    await mockUTXORepository.recalculateAllBalances();
  })
};

// Enhanced Block Processor with comprehensive validation and processing
const mockBlockProcessor = {
  processBlock: vi.fn().mockImplementation(async (block: Block) => {
    // Simulate processing delay
    await new Promise(resolve => setTimeout(resolve, Math.random() * 20));

    // Comprehensive block validation
    if (mockDatabaseState.blocks.has(block.height)) {
      return {
        success: false,
        error: `Block at height ${block.height} already processed`,
        blockHeight: block.height
      };
    }

    // Height validation
    const expectedHeight = mockDatabaseState.currentHeight + 1;
    if (block.height !== expectedHeight && !(block.height === 1 && mockDatabaseState.currentHeight === 0)) {
      return {
        success: false,
        error: `Block height must be ${expectedHeight}, got ${block.height}`,
        blockHeight: block.height
      };
    }

    // Block ID validation
    const expectedId = calculateBlockId(block.height, block.transactions);
    if (block.id !== expectedId) {
      return {
        success: false,
        error: 'Block ID validation failed',
        blockHeight: block.height
      };
    }

    // Transaction validation - need to handle intra-block dependencies
    const blockUTXOs = new Map<string, { address: string; value: number }>();

    for (const tx of block.transactions) {
      if (tx.inputs.length > 0) { // Not genesis transaction
        let inputSum = 0;

        // Validate all inputs exist and are unspent
        for (const input of tx.inputs) {
          // Check if UTXO exists in current block first
          const blockUTXOKey = `${input.txId}:${input.index}`;
          let utxo = blockUTXOs.get(blockUTXOKey);

          if (!utxo) {
            // Check existing UTXOs
            utxo = await mockUTXORepository.getUTXO(input.txId, input.index);
            if (!utxo) {
              return {
                success: false,
                error: `UTXO not found: ${input.txId}:${input.index}`,
                blockHeight: block.height
              };
            }
          }
          inputSum += utxo.value;
        }

        const outputSum = tx.outputs.reduce((sum, output) => sum + output.value, 0);
        if (inputSum !== outputSum) {
          return {
            success: false,
            error: `Transaction balance validation failed: input sum (${inputSum}) ≠ output sum (${outputSum})`,
            blockHeight: block.height
          };
        }
      }

      // Add this transaction's outputs to block UTXOs for intra-block dependencies
      for (let i = 0; i < tx.outputs.length; i++) {
        const output = tx.outputs[i];
        blockUTXOs.set(`${tx.id}:${i}`, {
          address: output.address,
          value: output.value
        });
      }
    }

    // Process the block atomically
    try {
      // Store block
      mockDatabaseState.blocks.set(block.height, block);
      mockDatabaseState.currentHeight = block.height;

      // Process all transactions
      for (const tx of block.transactions) {
        mockDatabaseState.transactions.set(tx.id, tx);

        // Spend inputs
        if (tx.inputs.length > 0) {
          await mockUTXORepository.spendUTXOs(tx.inputs, tx.id, block.height);

          // Update balances for spent UTXOs
          for (const input of tx.inputs) {
            const utxo = mockDatabaseState.utxos.get(`${input.txId}:${input.index}`);
            if (utxo) {
              const currentBalance = mockDatabaseState.balances.get(utxo.address) || 0;
              mockDatabaseState.balances.set(utxo.address, currentBalance - utxo.value);
            }
          }
        }

        // Create outputs
        await mockUTXORepository.saveUTXOs(tx.outputs, tx.id, block.height);

        // Update balances for new outputs
        for (const output of tx.outputs) {
          const currentBalance = mockDatabaseState.balances.get(output.address) || 0;
          mockDatabaseState.balances.set(output.address, currentBalance + output.value);
        }
      }

      return {
        success: true,
        blockHeight: block.height,
        message: `Block ${block.height} processed successfully`
      };
    } catch (error) {
      // Rollback on error
      mockDatabaseState.blocks.delete(block.height);
      mockDatabaseState.currentHeight = block.height - 1;

      return {
        success: false,
        error: `Block processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        blockHeight: block.height
      };
    }
  }),

  rollbackToHeight: vi.fn().mockImplementation(async (targetHeight: number) => {
    // Simulate rollback processing delay
    await new Promise(resolve => setTimeout(resolve, Math.random() * 50));

    // Validation
    if (targetHeight > mockDatabaseState.currentHeight) {
      return {
        success: false,
        error: `Target height ${targetHeight} is greater than current height ${mockDatabaseState.currentHeight}`,
        blockHeight: targetHeight
      };
    }

    if (targetHeight < 0) {
      return {
        success: false,
        error: 'Target height cannot be negative',
        blockHeight: targetHeight
      };
    }

    if (mockDatabaseState.currentHeight - targetHeight > 2000) {
      return {
        success: false,
        error: 'Rollback limited to 2000 blocks',
        blockHeight: targetHeight
      };
    }

    try {
      // Remove blocks after target height
      for (let height = mockDatabaseState.currentHeight; height > targetHeight; height--) {
        mockDatabaseState.blocks.delete(height);
      }

      // Clear all UTXOs and balances
      mockDatabaseState.utxos.clear();
      mockDatabaseState.balances.clear();
      mockDatabaseState.transactions.clear();

      // Rebuild state from remaining blocks
      for (let height = 1; height <= targetHeight; height++) {
        const block = mockDatabaseState.blocks.get(height);
        if (block) {
          for (const tx of block.transactions) {
            mockDatabaseState.transactions.set(tx.id, tx);

            // Create outputs
            for (let i = 0; i < tx.outputs.length; i++) {
              const output = tx.outputs[i];
              const key = `${tx.id}:${i}`;
              mockDatabaseState.utxos.set(key, {
                address: output.address,
                value: output.value,
                txId: tx.id,
                index: i,
                isSpent: false
              });
            }

            // Spend inputs
            for (const input of tx.inputs) {
              const key = `${input.txId}:${input.index}`;
              const utxo = mockDatabaseState.utxos.get(key);
              if (utxo) {
                utxo.isSpent = true;
              }
            }
          }
        }
      }

      // Recalculate balances from unspent UTXOs
      for (const [key, utxo] of mockDatabaseState.utxos.entries()) {
        if (!utxo.isSpent) {
          const currentBalance = mockDatabaseState.balances.get(utxo.address) || 0;
          mockDatabaseState.balances.set(utxo.address, currentBalance + utxo.value);
        }
      }

      // Update current height
      mockDatabaseState.currentHeight = targetHeight;

      return {
        success: true,
        blockHeight: targetHeight,
        message: `Successfully rolled back to height ${targetHeight}`
      };
    } catch (error) {
      return {
        success: false,
        error: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        blockHeight: targetHeight
      };
    }
  })
};

// Type declarations moved to src/types/fastify.d.ts

describe('End-to-End System Tests', () => {
  let app: FastifyInstance;

  // Helper function to create test block
  function createTestBlock(height: number, transactions: Transaction[]): Block {
    return {
      height,
      id: calculateBlockId(height, transactions),
      transactions
    };
  }

  // Helper function to clean database state
  async function cleanDatabase() {
    mockDatabaseState.blocks.clear();
    mockDatabaseState.transactions.clear();
    mockDatabaseState.utxos.clear();
    mockDatabaseState.balances.clear();
    mockDatabaseState.currentHeight = 0;
    mockDatabaseState.processingQueue = [];
    mockDatabaseState.isProcessing = false;
  }

  // Helper function to create a realistic blockchain scenario
  async function setupRealisticBlockchain() {
    // Genesis block with initial distribution
    const genesisTransaction: Transaction = {
      id: 'genesis-tx',
      inputs: [],
      outputs: [
        { address: 'alice', value: 10000 },
        { address: 'bob', value: 5000 },
        { address: 'charlie', value: 3000 }
      ]
    };
    const genesisBlock = createTestBlock(1, [genesisTransaction]);

    const genesisResponse = await app.inject({
      method: 'POST',
      url: '/blocks',
      payload: genesisBlock
    });
    expect(genesisResponse.statusCode).toBe(200);

    return { genesisBlock, genesisTransaction };
  }

  beforeAll(async () => {
    // Create Fastify instance
    app = Fastify({ logger: false });

    // Register all dependencies
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
    await cleanDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Complete Workflow Tests - Block Submission to Balance Queries', () => {
    it('should handle complete blockchain workflow from genesis to complex transactions', async () => {
      // Requirements: 1.1, 1.2, 2.1

      // Step 1: Setup genesis block
      const { genesisTransaction } = await setupRealisticBlockchain();

      // Step 2: Verify initial balances
      const aliceInitialBalance = await app.inject({
        method: 'GET',
        url: '/balance/alice'
      });
      expect(JSON.parse(aliceInitialBalance.body).balance).toBe(10000);

      const bobInitialBalance = await app.inject({
        method: 'GET',
        url: '/balance/bob'
      });
      expect(JSON.parse(bobInitialBalance.body).balance).toBe(5000);

      // Step 3: Alice sends money to Dave and Eve
      const tx1: Transaction = {
        id: 'tx1-alice-to-dave-eve',
        inputs: [{ txId: 'genesis-tx', index: 0 }], // Alice's 10000
        outputs: [
          { address: 'dave', value: 4000 },
          { address: 'eve', value: 3000 },
          { address: 'alice', value: 3000 } // Change back to Alice
        ]
      };
      const block2 = createTestBlock(2, [tx1]);

      const block2Response = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: block2
      });
      expect(block2Response.statusCode).toBe(200);

      // Step 4: Verify balances after first transaction
      const aliceBalance2 = await app.inject({
        method: 'GET',
        url: '/balance/alice'
      });
      expect(JSON.parse(aliceBalance2.body).balance).toBe(3000);

      const daveBalance = await app.inject({
        method: 'GET',
        url: '/balance/dave'
      });
      expect(JSON.parse(daveBalance.body).balance).toBe(4000);

      // Step 5: Bob and Charlie send money to Frank
      const tx2: Transaction = {
        id: 'tx2-bob-to-frank',
        inputs: [{ txId: 'genesis-tx', index: 1 }], // Bob's 5000
        outputs: [
          { address: 'frank', value: 2000 },
          { address: 'bob', value: 3000 } // Change back to Bob
        ]
      };

      const tx3: Transaction = {
        id: 'tx3-charlie-to-frank',
        inputs: [{ txId: 'genesis-tx', index: 2 }], // Charlie's 3000
        outputs: [
          { address: 'frank', value: 1500 },
          { address: 'charlie', value: 1500 } // Change back to Charlie
        ]
      };

      const block3 = createTestBlock(3, [tx2, tx3]);

      const block3Response = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: block3
      });
      expect(block3Response.statusCode).toBe(200);

      // Step 6: Verify final balances
      const finalBalances = await Promise.all([
        app.inject({ method: 'GET', url: '/balance/alice' }),
        app.inject({ method: 'GET', url: '/balance/bob' }),
        app.inject({ method: 'GET', url: '/balance/charlie' }),
        app.inject({ method: 'GET', url: '/balance/dave' }),
        app.inject({ method: 'GET', url: '/balance/eve' }),
        app.inject({ method: 'GET', url: '/balance/frank' })
      ]);

      const balances = finalBalances.map(response => JSON.parse(response.body).balance);
      expect(balances).toEqual([3000, 3000, 1500, 4000, 3000, 3500]);

      // Step 7: Verify total supply is conserved
      const totalSupply = balances.reduce((sum, balance) => sum + balance, 0);
      expect(totalSupply).toBe(18000); // Original genesis total
    });

    it('should handle complex multi-input multi-output transactions', async () => {
      // Requirements: 1.1, 1.2

      await setupRealisticBlockchain();

      // Create a complex transaction with multiple inputs and outputs
      const complexTx: Transaction = {
        id: 'complex-tx',
        inputs: [
          { txId: 'genesis-tx', index: 0 }, // Alice: 10000
          { txId: 'genesis-tx', index: 1 }  // Bob: 5000
        ],
        outputs: [
          { address: 'merchant1', value: 7000 },
          { address: 'merchant2', value: 4000 },
          { address: 'alice', value: 2000 }, // Change to Alice
          { address: 'bob', value: 2000 }    // Change to Bob
        ]
      };

      const complexBlock = createTestBlock(2, [complexTx]);

      const response = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: complexBlock
      });
      expect(response.statusCode).toBe(200);

      // Verify all balances
      const balanceChecks = await Promise.all([
        app.inject({ method: 'GET', url: '/balance/alice' }),
        app.inject({ method: 'GET', url: '/balance/bob' }),
        app.inject({ method: 'GET', url: '/balance/charlie' }),
        app.inject({ method: 'GET', url: '/balance/merchant1' }),
        app.inject({ method: 'GET', url: '/balance/merchant2' })
      ]);

      const balances = balanceChecks.map(r => JSON.parse(r.body).balance);
      expect(balances).toEqual([2000, 2000, 3000, 7000, 4000]);
    });

    it('should handle transaction chains and dependencies', async () => {
      // Requirements: 1.1, 1.2

      await setupRealisticBlockchain();

      // Transaction 1: Alice -> Dave
      const tx1: Transaction = {
        id: 'tx1-chain',
        inputs: [{ txId: 'genesis-tx', index: 0 }],
        outputs: [
          { address: 'dave', value: 6000 },
          { address: 'alice', value: 4000 }
        ]
      };

      // Transaction 2: Dave -> Eve (depends on tx1)
      const tx2: Transaction = {
        id: 'tx2-chain',
        inputs: [{ txId: 'tx1-chain', index: 0 }],
        outputs: [
          { address: 'eve', value: 3000 },
          { address: 'dave', value: 3000 }
        ]
      };

      // Both transactions in same block
      const chainBlock = createTestBlock(2, [tx1, tx2]);

      const response = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: chainBlock
      });
      expect(response.statusCode).toBe(200);

      // Verify final balances
      const balanceChecks = await Promise.all([
        app.inject({ method: 'GET', url: '/balance/alice' }),
        app.inject({ method: 'GET', url: '/balance/dave' }),
        app.inject({ method: 'GET', url: '/balance/eve' })
      ]);

      const balances = balanceChecks.map(r => JSON.parse(r.body).balance);
      expect(balances).toEqual([4000, 3000, 3000]);
    });
  });

  describe('Rollback Scenarios with Multiple Blocks and Addresses', () => {
    it('should handle rollback with complex transaction history', async () => {
      // Requirements: 3.1

      // Setup complex blockchain state
      await setupRealisticBlockchain();

      // Block 2: Multiple transactions
      const block2Transactions: Transaction[] = [
        {
          id: 'tx2-1',
          inputs: [{ txId: 'genesis-tx', index: 0 }],
          outputs: [
            { address: 'dave', value: 5000 },
            { address: 'alice', value: 5000 }
          ]
        },
        {
          id: 'tx2-2',
          inputs: [{ txId: 'genesis-tx', index: 1 }],
          outputs: [{ address: 'eve', value: 5000 }]
        }
      ];
      const block2 = createTestBlock(2, block2Transactions);
      await app.inject({ method: 'POST', url: '/blocks', payload: block2 });

      // Block 3: More transactions
      const block3Transactions: Transaction[] = [
        {
          id: 'tx3-1',
          inputs: [{ txId: 'tx2-1', index: 0 }],
          outputs: [
            { address: 'frank', value: 2500 },
            { address: 'dave', value: 2500 }
          ]
        }
      ];
      const block3 = createTestBlock(3, block3Transactions);
      await app.inject({ method: 'POST', url: '/blocks', payload: block3 });

      // Verify state before rollback
      const preRollbackBalances = await Promise.all([
        app.inject({ method: 'GET', url: '/balance/alice' }),
        app.inject({ method: 'GET', url: '/balance/dave' }),
        app.inject({ method: 'GET', url: '/balance/eve' }),
        app.inject({ method: 'GET', url: '/balance/frank' })
      ]);
      const preBalances = preRollbackBalances.map(r => JSON.parse(r.body).balance);
      expect(preBalances).toEqual([5000, 2500, 5000, 2500]);

      // Rollback to height 2
      const rollbackResponse = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { height: 2 }
      });
      expect(rollbackResponse.statusCode).toBe(200);

      // Verify state after rollback
      const postRollbackBalances = await Promise.all([
        app.inject({ method: 'GET', url: '/balance/alice' }),
        app.inject({ method: 'GET', url: '/balance/dave' }),
        app.inject({ method: 'GET', url: '/balance/eve' }),
        app.inject({ method: 'GET', url: '/balance/frank' })
      ]);
      const postBalances = postRollbackBalances.map(r => JSON.parse(r.body).balance);
      expect(postBalances).toEqual([5000, 5000, 5000, 0]); // Frank should have 0 after rollback
    });

    it('should handle rollback to genesis state', async () => {
      // Requirements: 3.1

      // Setup complex state
      await setupRealisticBlockchain();

      // Add multiple blocks
      for (let i = 2; i <= 5; i++) {
        const tx: Transaction = {
          id: `tx-${i}`,
          inputs: [{ txId: 'genesis-tx', index: 0 }],
          outputs: [
            { address: `addr-${i}`, value: 1000 },
            { address: 'alice', value: 9000 }
          ]
        };
        const block = createTestBlock(i, [tx]);
        await app.inject({ method: 'POST', url: '/blocks', payload: block });
      }

      // Rollback to genesis (height 1)
      const rollbackResponse = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { height: 1 }
      });
      expect(rollbackResponse.statusCode).toBe(200);

      // Verify genesis state is restored
      const genesisBalances = await Promise.all([
        app.inject({ method: 'GET', url: '/balance/alice' }),
        app.inject({ method: 'GET', url: '/balance/bob' }),
        app.inject({ method: 'GET', url: '/balance/charlie' }),
        app.inject({ method: 'GET', url: '/balance/addr-2' })
      ]);
      const balances = genesisBalances.map(r => JSON.parse(r.body).balance);
      expect(balances).toEqual([10000, 5000, 3000, 0]);
    });

    it('should handle complete reset (rollback to height 0)', async () => {
      // Requirements: 3.1

      await setupRealisticBlockchain();

      // Add more blocks
      for (let i = 2; i <= 3; i++) {
        const tx: Transaction = {
          id: `reset-tx-${i}`,
          inputs: [{ txId: 'genesis-tx', index: 0 }],
          outputs: [{ address: `reset-addr-${i}`, value: 10000 }]
        };
        const block = createTestBlock(i, [tx]);
        await app.inject({ method: 'POST', url: '/blocks', payload: block });
      }

      // Complete reset
      const resetResponse = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { height: 0 }
      });
      expect(resetResponse.statusCode).toBe(200);

      // Verify all balances are zero
      const resetBalances = await Promise.all([
        app.inject({ method: 'GET', url: '/balance/alice' }),
        app.inject({ method: 'GET', url: '/balance/bob' }),
        app.inject({ method: 'GET', url: '/balance/charlie' }),
        app.inject({ method: 'GET', url: '/balance/reset-addr-2' })
      ]);
      const balances = resetBalances.map(r => JSON.parse(r.body).balance);
      expect(balances).toEqual([0, 0, 0, 0]);
    });

    it('should validate rollback limits and constraints', async () => {
      // Requirements: 3.1

      await setupRealisticBlockchain();

      // Test rollback to future height (should fail)
      const futureRollback = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { height: 10 }
      });
      expect(futureRollback.statusCode).toBe(400);

      // Test negative height (should fail)
      const negativeRollback = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { height: -1 }
      });
      expect(negativeRollback.statusCode).toBe(400);

      // Simulate 2000+ block scenario
      mockDatabaseState.currentHeight = 2500;
      const limitRollback = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { height: 400 } // 2100 blocks back (exceeds 2000 limit)
      });
      expect([400, 409]).toContain(limitRollback.statusCode); // Accept either status code
      expect(JSON.parse(limitRollback.body).error).toContain('2000 blocks');
    });
  });

  describe('System Behavior Under Load Conditions', () => {
    it('should handle high-frequency balance queries', async () => {
      // Requirements: 4.1

      await setupRealisticBlockchain();

      // Generate many concurrent balance queries
      const queryPromises = Array.from({ length: 100 }, (_, i) => {
        const addresses = ['alice', 'bob', 'charlie', 'nonexistent'];
        const address = addresses[i % addresses.length];
        return app.inject({
          method: 'GET',
          url: `/balance/${address}`
        });
      });

      const responses = await Promise.all(queryPromises);

      // All queries should succeed
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.address).toBeDefined();
        expect(typeof body.balance).toBe('number');
      }

      // Verify consistent results for same addresses
      const aliceQueries = responses.filter((_, i) => i % 4 === 0);
      const aliceBalances = aliceQueries.map(r => JSON.parse(r.body).balance);
      expect(new Set(aliceBalances).size).toBe(1); // All should be the same
    });

    it('should handle concurrent block processing attempts', async () => {
      // Requirements: 4.1

      await setupRealisticBlockchain();

      // Create multiple blocks to submit concurrently
      const concurrentBlocks = Array.from({ length: 10 }, (_, i) => {
        const tx: Transaction = {
          id: `concurrent-tx-${i + 2}`,
          inputs: [{ txId: 'genesis-tx', index: 0 }],
          outputs: [
            { address: `concurrent-addr-${i}`, value: 5000 },
            { address: 'alice', value: 5000 }
          ]
        };
        return createTestBlock(i + 2, [tx]);
      });

      // Submit all blocks concurrently
      const blockPromises = concurrentBlocks.map(block =>
        app.inject({
          method: 'POST',
          url: '/blocks',
          payload: block
        })
      );

      const responses = await Promise.all(blockPromises);

      // Only one block should succeed (sequential processing)
      const successfulResponses = responses.filter(r => r.statusCode === 200);
      const failedResponses = responses.filter(r => r.statusCode !== 200);

      expect(successfulResponses.length).toBe(1);
      expect(failedResponses.length).toBe(9);

      // Failed responses should have appropriate error messages
      for (const response of failedResponses) {
        const body = JSON.parse(response.body);
        expect(body.error).toBeDefined();
      }
    });

    it('should handle mixed concurrent operations (blocks + queries + rollbacks)', async () => {
      // Requirements: 4.1

      await setupRealisticBlockchain();

      // Create mixed operations
      const operations = [
        // Block processing
        app.inject({
          method: 'POST',
          url: '/blocks',
          payload: createTestBlock(2, [{
            id: 'mixed-tx-1',
            inputs: [{ txId: 'genesis-tx', index: 0 }],
            outputs: [{ address: 'mixed-addr', value: 10000 }]
          }])
        }),

        // Balance queries
        ...Array.from({ length: 20 }, () =>
          app.inject({ method: 'GET', url: '/balance/alice' })
        ),

        // Rollback attempt
        app.inject({
          method: 'POST',
          url: '/rollback',
          payload: { height: 1 }
        }),

        // More balance queries
        ...Array.from({ length: 10 }, () =>
          app.inject({ method: 'GET', url: '/balance/bob' })
        )
      ];

      const responses = await Promise.all(operations);

      // Categorize responses
      const blockResponses = responses.slice(0, 1);
      const balanceResponses = responses.slice(1, 21);
      const rollbackResponses = responses.slice(21, 22);
      const moreBalanceResponses = responses.slice(22);

      // At least some operations should succeed
      const successfulOperations = responses.filter(r => r.statusCode === 200);
      expect(successfulOperations.length).toBeGreaterThan(0);

      // Balance queries should generally succeed
      const successfulBalanceQueries = [...balanceResponses, ...moreBalanceResponses]
        .filter(r => r.statusCode === 200);
      expect(successfulBalanceQueries.length).toBeGreaterThan(20);
    });

    it('should maintain data consistency under concurrent load', async () => {
      // Requirements: 4.1

      await setupRealisticBlockchain();

      // Perform many operations and verify consistency
      const operations = [];

      // Add balance queries
      for (let i = 0; i < 50; i++) {
        operations.push(
          app.inject({ method: 'GET', url: '/balance/alice' })
        );
      }

      // Add block processing attempts
      for (let i = 0; i < 5; i++) {
        const tx: Transaction = {
          id: `consistency-tx-${i}`,
          inputs: [{ txId: 'genesis-tx', index: 0 }],
          outputs: [{ address: 'alice', value: 10000 }]
        };
        operations.push(
          app.inject({
            method: 'POST',
            url: '/blocks',
            payload: createTestBlock(i + 2, [tx])
          })
        );
      }

      const responses = await Promise.all(operations);

      // Check that balance queries return consistent values
      const balanceResponses = responses.slice(0, 50);
      const successfulBalanceQueries = balanceResponses.filter(r => r.statusCode === 200);

      if (successfulBalanceQueries.length > 0) {
        const balances = successfulBalanceQueries.map(r => JSON.parse(r.body).balance);
        const uniqueBalances = new Set(balances);

        // Should have at most 2 different balance values (before and after any successful block)
        expect(uniqueBalances.size).toBeLessThanOrEqual(2);
      }

      // Verify final state consistency
      const finalBalance = await app.inject({ method: 'GET', url: '/balance/alice' });
      expect(finalBalance.statusCode).toBe(200);

      const finalBalanceValue = JSON.parse(finalBalance.body).balance;
      expect(typeof finalBalanceValue).toBe('number');
      expect(finalBalanceValue).toBeGreaterThanOrEqual(0);
    });

    it('should handle stress test with rapid sequential operations', async () => {
      // Requirements: 4.1

      await setupRealisticBlockchain();

      const startTime = Date.now();
      const operations = [];

      // Rapid fire operations
      for (let i = 0; i < 100; i++) {
        if (i % 10 === 0) {
          // Every 10th operation is a block attempt
          const tx: Transaction = {
            id: `stress-tx-${i}`,
            inputs: [{ txId: 'genesis-tx', index: 0 }],
            outputs: [{ address: 'stress-addr', value: 10000 }]
          };
          operations.push(
            app.inject({
              method: 'POST',
              url: '/blocks',
              payload: createTestBlock(Math.floor(i / 10) + 2, [tx])
            })
          );
        } else {
          // Balance query
          operations.push(
            app.inject({ method: 'GET', url: '/balance/alice' })
          );
        }
      }

      const responses = await Promise.all(operations);
      const endTime = Date.now();

      // Performance check - should complete within reasonable time
      const duration = endTime - startTime;
      expect(duration).toBeLessThan(10000); // 10 seconds max

      // Verify response distribution
      const successfulResponses = responses.filter(r => r.statusCode === 200);
      const errorResponses = responses.filter(r => r.statusCode !== 200);

      // Most balance queries should succeed
      expect(successfulResponses.length).toBeGreaterThan(80);

      // Some block operations may fail due to concurrency
      expect(errorResponses.length).toBeLessThan(50);

      // System should remain responsive
      const healthCheck = await app.inject({ method: 'GET', url: '/health' });
      expect(healthCheck.statusCode).toBe(200);
    });
  });

  describe('Error Recovery and System Resilience', () => {
    it('should recover from processing errors gracefully', async () => {
      // Requirements: 4.1

      await setupRealisticBlockchain();

      // Simulate processing error by submitting invalid block
      const invalidTx: Transaction = {
        id: 'invalid-tx',
        inputs: [{ txId: 'nonexistent-tx', index: 0 }],
        outputs: [{ address: 'test-addr', value: 1000 }]
      };
      const invalidBlock = createTestBlock(2, [invalidTx]);

      const errorResponse = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: invalidBlock
      });
      expect(errorResponse.statusCode).toBe(400);

      // System should still be functional after error
      const balanceCheck = await app.inject({ method: 'GET', url: '/balance/alice' });
      expect(balanceCheck.statusCode).toBe(200);

      // Should be able to process valid blocks after error
      const validTx: Transaction = {
        id: 'recovery-tx',
        inputs: [{ txId: 'genesis-tx', index: 0 }],
        outputs: [{ address: 'recovery-addr', value: 10000 }]
      };
      const validBlock = createTestBlock(2, [validTx]);

      const recoveryResponse = await app.inject({
        method: 'POST',
        url: '/blocks',
        payload: validBlock
      });
      expect(recoveryResponse.statusCode).toBe(200);
    });

    it('should maintain system health under error conditions', async () => {
      // Requirements: 4.1

      await setupRealisticBlockchain();

      // Generate multiple error conditions
      const errorOperations = [
        // Invalid blocks
        ...Array.from({ length: 10 }, (_, i) =>
          app.inject({
            method: 'POST',
            url: '/blocks',
            payload: { invalid: 'block', height: i + 2 }
          })
        ),

        // Invalid addresses
        ...Array.from({ length: 10 }, () =>
          app.inject({ method: 'GET', url: '/balance/invalid@address' })
        ),

        // Invalid rollbacks
        ...Array.from({ length: 5 }, (_, i) =>
          app.inject({
            method: 'POST',
            url: '/rollback',
            payload: { height: -i - 1 }
          })
        )
      ];

      const errorResponses = await Promise.all(errorOperations);

      // All should return appropriate error codes
      for (const response of errorResponses) {
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
      }

      // System should still be healthy
      const healthCheck = await app.inject({ method: 'GET', url: '/health' });
      expect(healthCheck.statusCode).toBe(200);

      // Normal operations should still work
      const normalBalance = await app.inject({ method: 'GET', url: '/balance/alice' });
      expect(normalBalance.statusCode).toBe(200);
    });
  });
});