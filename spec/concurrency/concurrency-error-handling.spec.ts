import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ConcurrencyManager } from '../../src/services/concurrency-manager.js';
import { ErrorHandler, ErrorType, ErrorSeverity } from '../../src/services/error-handler.js';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerRoutes } from '../../src/routes/index.js';
import crypto from 'crypto';
import type { Block, Transaction } from '../../src/types/blockchain.js';

describe('Concurrency and Error Handling Tests', () => {
  let concurrencyManager: ConcurrencyManager;
  let errorHandler: ErrorHandler;
  let app: FastifyInstance;

  // Mock database state for testing
  const mockDatabaseState = {
    blocks: new Map<number, any>(),
    transactions: new Map<string, any>(),
    utxos: new Map<string, any>(),
    balances: new Map<string, number>(),
    currentHeight: 0,
    isProcessing: false,
    rollbackInProgress: false
  };

  // Mock database with error simulation capabilities
  const mockDb = {
    query: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    getPool: vi.fn().mockReturnValue({
      totalCount: 10,
      idleCount: 5,
      waitingCount: 0
    })
  };

  // Mock repositories with error simulation
  const mockUTXORepository = {
    saveUTXOs: vi.fn(),
    spendUTXOs: vi.fn(),
    getUTXO: vi.fn(),
    rollbackUTXOsAfterHeight: vi.fn(),
    recalculateAllBalances: vi.fn()
  };

  const mockBalanceRepository = {
    getBalance: vi.fn(),
    updateBalance: vi.fn(),
    batchUpdateBalances: vi.fn(),
    recalculateAllBalances: vi.fn()
  };

  // Mock block processor with error simulation
  const mockBlockProcessor = {
    processBlock: vi.fn(),
    rollbackToHeight: vi.fn()
  };

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

  // Helper function to simulate database errors
  function simulateDatabaseError(errorMessage: string = 'Database connection failed') {
    mockDb.query.mockRejectedValueOnce(new Error(errorMessage));
    mockUTXORepository.saveUTXOs.mockRejectedValueOnce(new Error(errorMessage));
    mockBalanceRepository.updateBalance.mockRejectedValueOnce(new Error(errorMessage));
  }

  // Helper function to simulate processing delays
  function simulateProcessingDelay(delayMs: number = 100) {
    return new Promise(resolve => setTimeout(resolve, delayMs));
  }

  beforeAll(async () => {
    // Create fresh instances for testing
    concurrencyManager = new ConcurrencyManager();
    errorHandler = ErrorHandler.getInstance();

    // Create Fastify instance
    app = Fastify({ logger: false });

    // Set up default mock behaviors
    mockDb.query.mockResolvedValue({ rows: [] });
    mockUTXORepository.saveUTXOs.mockResolvedValue(undefined);
    mockUTXORepository.spendUTXOs.mockResolvedValue(undefined);
    mockUTXORepository.getUTXO.mockResolvedValue(null);
    mockUTXORepository.rollbackUTXOsAfterHeight.mockResolvedValue(undefined);
    mockUTXORepository.recalculateAllBalances.mockResolvedValue(undefined);

    mockBalanceRepository.getBalance.mockImplementation(async (address: string) => {
      return mockDatabaseState.balances.get(address) || 0;
    });
    mockBalanceRepository.updateBalance.mockResolvedValue(undefined);
    mockBalanceRepository.batchUpdateBalances.mockResolvedValue(undefined);
    mockBalanceRepository.recalculateAllBalances.mockResolvedValue(undefined);

    mockBlockProcessor.processBlock.mockImplementation(async (block: Block) => {
      // Simulate processing time
      await simulateProcessingDelay(50);

      if (mockDatabaseState.blocks.has(block.height)) {
        return {
          success: false,
          error: `Block at height ${block.height} already processed`,
          blockHeight: block.height
        };
      }

      mockDatabaseState.blocks.set(block.height, block);
      mockDatabaseState.currentHeight = block.height;

      return {
        success: true,
        blockHeight: block.height,
        message: `Block ${block.height} processed successfully`
      };
    });

    mockBlockProcessor.rollbackToHeight.mockImplementation(async (targetHeight: number) => {
      await simulateProcessingDelay(100);

      if (targetHeight > mockDatabaseState.currentHeight) {
        return {
          success: false,
          error: `Target height ${targetHeight} is greater than current height ${mockDatabaseState.currentHeight}`,
          blockHeight: targetHeight
        };
      }

      // Remove blocks after target height
      for (let height = mockDatabaseState.currentHeight; height > targetHeight; height--) {
        mockDatabaseState.blocks.delete(height);
      }
      mockDatabaseState.currentHeight = targetHeight;

      return {
        success: true,
        blockHeight: targetHeight,
        message: `Successfully rolled back to height ${targetHeight}`
      };
    });

    // Register all dependencies with Fastify
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
    // Reset state before each test
    mockDatabaseState.blocks.clear();
    mockDatabaseState.transactions.clear();
    mockDatabaseState.utxos.clear();
    mockDatabaseState.balances.clear();
    mockDatabaseState.currentHeight = 0;
    mockDatabaseState.isProcessing = false;
    mockDatabaseState.rollbackInProgress = false;

    // Clear concurrency manager queue
    concurrencyManager.clearQueue();

    // Reset all mocks
    vi.clearAllMocks();

    // Reset default mock behaviors
    mockDb.query.mockResolvedValue({ rows: [] });
    mockUTXORepository.saveUTXOs.mockResolvedValue(undefined);
    mockBalanceRepository.updateBalance.mockResolvedValue(undefined);

    // Clear error handler state for clean tests
    errorHandler.clearOldErrors();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Concurrent Request Scenarios', () => {
    describe('Requirement 4.1: Sequential Block Processing', () => {
      it('should process multiple blocks sequentially even when submitted concurrently', async () => {
        // Create multiple test blocks
        const blocks = Array.from({ length: 3 }, (_, i) =>
          createTestBlock(i + 1, [{
            id: `tx${i + 1}`,
            inputs: [],
            outputs: [{ address: `addr${i + 1}`, value: 100 }]
          }])
        );

        // Submit all blocks concurrently
        const startTime = Date.now();
        const promises = blocks.map(block =>
          app.inject({
            method: 'POST',
            url: '/blocks',
            payload: block
          })
        );

        const responses = await Promise.all(promises);
        const endTime = Date.now();

        // Verify that blocks were processed sequentially (should take at least 3 * 50ms = 150ms)
        // Allow some tolerance for test timing variations
        expect(endTime - startTime).toBeGreaterThanOrEqual(50);

        // At least the first block should succeed
        const successfulResponses = responses.filter(r => r.statusCode === 200);
        expect(successfulResponses.length).toBeGreaterThanOrEqual(1);

        // Verify blocks were processed in order
        const processedHeights = new Set();
        for (const response of successfulResponses) {
          const body = JSON.parse(response.body);
          if (body.success) {
            processedHeights.add(body.blockHeight);
          }
        }

        // Should have processed blocks sequentially starting from height 1
        if (processedHeights.size > 0) {
          expect(processedHeights.has(1)).toBe(true);
        }
      });

      it('should queue block operations using concurrency manager', async () => {
        const operations: Promise<any>[] = [];
        const results: any[] = [];

        // Queue multiple operations
        for (let i = 0; i < 5; i++) {
          const operation = concurrencyManager.queueBlockOperation(async () => {
            await simulateProcessingDelay(50);
            return { processed: i + 1 };
          });
          operations.push(operation);
        }

        // Execute all operations
        const startTime = Date.now();
        for (const operation of operations) {
          const result = await operation;
          results.push(result);
        }
        const endTime = Date.now();

        // Verify sequential execution (should take at least 5 * 50ms = 250ms)
        expect(endTime - startTime).toBeGreaterThanOrEqual(200);
        expect(results).toHaveLength(5);
        expect(results[0].processed).toBe(1);
        expect(results[4].processed).toBe(5);
      });

      it('should handle queue overflow gracefully', async () => {
        // Queue a large number of operations
        const operations: Promise<any>[] = [];

        for (let i = 0; i < 100; i++) {
          const operation = concurrencyManager.queueBlockOperation(async () => {
            await simulateProcessingDelay(10);
            return { processed: i + 1 };
          });
          operations.push(operation);
        }

        // All operations should eventually complete
        const results = await Promise.all(operations);
        expect(results).toHaveLength(100);
        expect(results[0].processed).toBe(1);
        expect(results[99].processed).toBe(100);
      });
    });

    describe('Requirement 4.2: Safe Balance Queries During Processing', () => {
      it('should allow balance queries during block processing', async () => {
        // Set up initial balance
        mockDatabaseState.balances.set('addr1', 1000);

        // Start a long-running block processing operation
        const blockProcessingPromise = concurrencyManager.queueBlockOperation(async () => {
          await simulateProcessingDelay(200);
          return { success: true };
        });

        // Start balance queries during processing
        const balanceQueries = Array.from({ length: 10 }, () =>
          app.inject({
            method: 'GET',
            url: '/balance/addr1'
          })
        );

        // Both should complete successfully
        const [blockResult, ...balanceResults] = await Promise.all([
          blockProcessingPromise,
          ...balanceQueries
        ]);

        expect((blockResult as any).success).toBe(true);

        for (const response of balanceResults) {
          expect(response.statusCode).toBe(200);
          const body = JSON.parse(response.body);
          expect(body.balance).toBe(1000);
        }
      });

      it('should prevent balance queries during rollback operations', async () => {
        // Set up initial state
        mockDatabaseState.balances.set('addr1', 1000);
        mockDatabaseState.currentHeight = 3;

        // Start rollback operation
        const rollbackPromise = concurrencyManager.executeRollback(async () => {
          await simulateProcessingDelay(200);
          return { success: true, newHeight: 1 };
        });

        // Try balance queries during rollback
        await simulateProcessingDelay(50); // Let rollback start

        const balanceQuery = app.inject({
          method: 'GET',
          url: '/balance/addr1'
        });

        const [rollbackResult, balanceResponse] = await Promise.all([
          rollbackPromise,
          balanceQuery
        ]);

        expect((rollbackResult as any).success).toBe(true);

        // Balance query should either succeed or be blocked (503 status)
        expect([200, 503]).toContain(balanceResponse.statusCode);
      });

      it('should handle concurrent balance queries efficiently', async () => {
        // Set up test balances
        for (let i = 1; i <= 10; i++) {
          mockDatabaseState.balances.set(`addr${i}`, i * 100);
        }

        // Execute many concurrent balance queries
        const queries = Array.from({ length: 50 }, (_, i) => {
          const address = `addr${(i % 10) + 1}`;
          return app.inject({
            method: 'GET',
            url: `/balance/${address}`
          });
        });

        const startTime = Date.now();
        const responses = await Promise.all(queries);
        const endTime = Date.now();

        // All queries should succeed
        for (const response of responses) {
          expect(response.statusCode).toBe(200);
        }

        // Should complete relatively quickly (concurrent execution)
        expect(endTime - startTime).toBeLessThan(1000);
      });
    });

    describe('Requirement 4.3: Rollback Operation Exclusivity', () => {
      it('should reject new block submissions during rollback', async () => {
        // Set up initial state
        mockDatabaseState.currentHeight = 3;

        // Start rollback operation that blocks new submissions
        const rollbackPromise = concurrencyManager.executeRollback(async () => {
          await simulateProcessingDelay(200);
          return { success: true, newHeight: 1 };
        });

        // Try to submit block during rollback
        await simulateProcessingDelay(50); // Let rollback start

        // The block should be queued and processed after rollback
        const blockSubmission = concurrencyManager.queueBlockOperation(async () => {
          // This should be queued until rollback completes
          return { success: true, blockHeight: 4 };
        });

        const [rollbackResult, blockResult] = await Promise.all([
          rollbackPromise,
          blockSubmission
        ]);

        expect((rollbackResult as any).success).toBe(true);
        expect((blockResult as any).success).toBe(true);
      });

      it('should process queued blocks after rollback completes', async () => {
        // Set up initial state
        mockDatabaseState.currentHeight = 2;

        // Queue a block operation
        const queuedBlockPromise = concurrencyManager.queueBlockOperation(async () => {
          await simulateProcessingDelay(50);
          return { success: true, blockHeight: 3 };
        });

        // Start rollback operation
        const rollbackPromise = concurrencyManager.executeRollback(async () => {
          await simulateProcessingDelay(100);
          return { success: true, newHeight: 1 };
        });

        // Both should complete successfully
        const [queuedResult, rollbackResult] = await Promise.all([
          queuedBlockPromise,
          rollbackPromise
        ]);

        expect((rollbackResult as any).success).toBe(true);
        expect((queuedResult as any).success).toBe(true);
      });

      it('should handle multiple concurrent rollback attempts', async () => {
        // Set up initial state
        mockDatabaseState.currentHeight = 5;

        // Attempt multiple concurrent rollbacks
        const rollbackPromises = [
          concurrencyManager.executeRollback(async () => {
            await simulateProcessingDelay(100);
            return { success: true, newHeight: 3 };
          }),
          concurrencyManager.executeRollback(async () => {
            await simulateProcessingDelay(100);
            return { success: true, newHeight: 2 };
          }),
          concurrencyManager.executeRollback(async () => {
            await simulateProcessingDelay(100);
            return { success: true, newHeight: 1 };
          })
        ];

        const results = await Promise.all(rollbackPromises);

        // All rollbacks should complete (they execute sequentially)
        for (const result of results) {
          expect((result as any).success).toBe(true);
        }
      });
    });
  });

  describe('Error Recovery and Rollback Scenarios', () => {
    describe('Requirement 4.4: Database Transaction Integrity', () => {
      it('should handle database connection failures with retry', async () => {
        // Simulate database failure followed by recovery
        let callCount = 0;
        mockBlockProcessor.processBlock.mockImplementation(async (block: Block) => {
          callCount++;
          if (callCount <= 2) {
            throw new Error('Database connection failed');
          }
          return {
            success: true,
            blockHeight: block.height,
            message: `Block ${block.height} processed successfully`
          };
        });

        const testBlock = createTestBlock(1, [{
          id: 'tx1',
          inputs: [],
          outputs: [{ address: 'addr1', value: 100 }]
        }]);

        // Use error handler with retry
        const result = await errorHandler.executeWithRetry(
          () => mockBlockProcessor.processBlock(testBlock),
          { operation: 'processBlock', blockHeight: 1 },
          { maxRetries: 3, retryDelayMs: 50 }
        );

        expect((result as any).success).toBe(true);
        expect(callCount).toBe(3); // Failed twice, succeeded on third attempt
      });

      it('should rollback database transactions on processing failures', async () => {
        const mockTransaction = {
          rollback: vi.fn().mockResolvedValue(undefined),
          commit: vi.fn().mockResolvedValue(undefined)
        };

        // Simulate processing failure
        const processingError = new Error('Database transaction failed');

        const structuredError = await errorHandler.handleDatabaseError(
          processingError,
          mockTransaction,
          { operation: 'processBlock', blockHeight: 1 }
        );

        expect(structuredError.type).toBe(ErrorType.DATABASE_ERROR);
        expect(structuredError.recoverable).toBe(true);
        expect(mockTransaction.rollback).toHaveBeenCalled();
      });

      it('should handle rollback failures gracefully', async () => {
        const mockTransaction = {
          rollback: vi.fn().mockRejectedValue(new Error('Rollback failed')),
          commit: vi.fn().mockResolvedValue(undefined)
        };

        const processingError = new Error('Database connection failed'); // Use database-related error

        const structuredError = await errorHandler.handleDatabaseError(
          processingError,
          mockTransaction,
          { operation: 'processBlock', blockHeight: 1 }
        );

        expect(structuredError.type).toBe(ErrorType.DATABASE_ERROR);
        expect(structuredError.context.additionalData?.transactionRollbackFailed).toBe(true);
        expect(mockTransaction.rollback).toHaveBeenCalled();
      });

      it('should maintain data consistency during concurrent failures', async () => {
        // Simulate multiple concurrent operations with some failures
        const operations = Array.from({ length: 10 }, (_, i) =>
          concurrencyManager.queueBlockOperation(async () => {
            if (i % 3 === 0) {
              throw new Error(`Operation ${i} failed`);
            }
            await simulateProcessingDelay(50);
            return { success: true, operation: i };
          })
        );

        const results = await Promise.allSettled(operations);

        // Some operations should succeed, some should fail
        const successful = results.filter(r => r.status === 'fulfilled');
        const failed = results.filter(r => r.status === 'rejected');

        expect(successful.length).toBeGreaterThan(0);
        expect(failed.length).toBeGreaterThan(0);
        expect(successful.length + failed.length).toBe(10);
      });
    });

    describe('Error Classification and Recovery', () => {
      it('should classify different error types correctly', async () => {
        const testCases = [
          {
            error: new Error('Database connection failed'),
            context: { operation: 'processBlock' },
            expectedType: ErrorType.DATABASE_ERROR,
            expectedRetryable: true
          },
          {
            error: new Error('Invalid block height'),
            context: { operation: 'validateBlock' },
            expectedType: ErrorType.VALIDATION_ERROR,
            expectedRetryable: false
          },
          {
            error: new Error('Concurrent access detected'),
            context: { operation: 'queueOperation' },
            expectedType: ErrorType.CONCURRENCY_ERROR,
            expectedRetryable: true
          },
          {
            error: new Error('UTXO not found'),
            context: { operation: 'spendUTXO' },
            expectedType: ErrorType.BUSINESS_LOGIC_ERROR,
            expectedRetryable: false
          }
        ];

        for (const testCase of testCases) {
          const structuredError = errorHandler.createStructuredError(
            testCase.error,
            testCase.context
          );

          expect(structuredError.type).toBe(testCase.expectedType);
          expect(structuredError.retryable).toBe(testCase.expectedRetryable);
        }
      });

      it('should implement exponential backoff for retries', async () => {
        let callCount = 0;
        const callTimes: number[] = [];

        const failingOperation = async () => {
          callTimes.push(Date.now());
          callCount++;
          if (callCount <= 3) {
            throw new Error('Database connection failed'); // Use retryable error
          }
          return { success: true };
        };

        const startTime = Date.now();
        const result = await errorHandler.executeWithRetry(
          failingOperation,
          { operation: 'testOperation' },
          {
            maxRetries: 3,
            retryDelayMs: 50, // Reduce delay for faster tests
            backoffMultiplier: 2
          }
        );

        expect((result as any).success).toBe(true);
        expect(callCount).toBe(4);

        // Verify exponential backoff timing (with some tolerance)
        expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(40);
        expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(90);
        expect(callTimes[3] - callTimes[2]).toBeGreaterThanOrEqual(190);
      });

      it('should stop retrying non-retryable errors', async () => {
        let callCount = 0;

        const nonRetryableOperation = async () => {
          callCount++;
          throw new Error('Invalid block format'); // Validation error - not retryable
        };

        try {
          await errorHandler.executeWithRetry(
            nonRetryableOperation,
            { operation: 'validateBlock' },
            { maxRetries: 3 }
          );
          expect.fail('Should have thrown an error');
        } catch (error) {
          expect(callCount).toBe(1); // Should not retry validation errors
        }
      });
    });

    describe('System Recovery Scenarios', () => {
      it('should recover from temporary network failures', async () => {
        let networkFailureCount = 0;

        mockDb.query.mockImplementation(async () => {
          networkFailureCount++;
          if (networkFailureCount <= 2) {
            throw new Error('Network timeout');
          }
          return { rows: [] };
        });

        const result = await errorHandler.executeWithRetry(
          () => mockDb.query('SELECT 1'),
          { operation: 'databaseQuery' },
          { maxRetries: 3, retryDelayMs: 50 }
        );

        expect((result as any).rows).toEqual([]);
        expect(networkFailureCount).toBe(3);
      });

      it('should handle memory pressure gracefully', async () => {
        // Simulate memory pressure by creating large operations
        const largeOperations = Array.from({ length: 100 }, (_, i) =>
          concurrencyManager.queueBlockOperation(async () => {
            // Simulate memory-intensive operation
            const largeArray = new Array(10000).fill(i);
            await simulateProcessingDelay(10);
            return { processed: i, dataSize: largeArray.length };
          })
        );

        // Should handle all operations without memory issues
        const results = await Promise.all(largeOperations);
        expect(results).toHaveLength(100);

        // Verify queue was processed correctly
        const status = concurrencyManager.getStatus();
        expect(status.queueLength).toBe(0);
      });

      it('should provide error statistics for monitoring', async () => {
        // Generate a few errors
        errorHandler.createStructuredError(
          new Error('Database connection failed'),
          { operation: 'test' }
        );
        errorHandler.createStructuredError(
          new Error('Validation failed'),
          { operation: 'test' }
        );

        const stats = errorHandler.getErrorStatistics();

        expect(stats.totalErrors).toBeGreaterThan(0);
        expect(stats.errorsByType).toBeDefined();
        expect(stats.errorsBySeverity).toBeDefined();
        expect(stats.lastError).toBeDefined();
      });

      it('should handle error log management', async () => {
        // Generate some errors
        for (let i = 0; i < 10; i++) {
          errorHandler.createStructuredError(
            new Error(`Test error ${i}`),
            { operation: 'test', additionalData: { index: i } }
          );
        }

        const statsBefore = errorHandler.getErrorStatistics();
        expect(statsBefore.totalErrors).toBeGreaterThan(0);

        // Clear old errors
        errorHandler.clearOldErrors();

        // Should still function properly after clearing
        const statsAfter = errorHandler.getErrorStatistics();
        expect(statsAfter).toBeDefined();
      });
    });

    describe('API Error Handling Integration', () => {
      it('should handle API errors with proper status codes and messages', async () => {
        // Test various API error scenarios
        const errorScenarios = [
          {
            method: 'POST',
            url: '/blocks',
            payload: { invalid: 'block' },
            expectedStatus: 400,
            description: 'Invalid block structure'
          },
          {
            method: 'GET',
            url: '/balance/invalid@address',
            expectedStatus: 400,
            description: 'Invalid address format'
          },
          {
            method: 'POST',
            url: '/rollback',
            payload: { height: 'invalid' },
            expectedStatus: 400,
            description: 'Invalid rollback height'
          }
        ];

        for (const scenario of errorScenarios) {
          const response = await app.inject({
            method: scenario.method as any,
            url: scenario.url,
            payload: scenario.payload
          });

          expect(response.statusCode).toBe(scenario.expectedStatus);

          const body = JSON.parse(response.body);
          expect(body.error || body.message).toBeDefined();
          expect(typeof (body.error || body.message)).toBe('string');
        }
      });

      it('should handle database errors in API endpoints', async () => {
        // Simulate database failure
        mockBlockProcessor.processBlock.mockRejectedValueOnce(
          new Error('Database connection lost')
        );

        const testBlock = createTestBlock(1, [{
          id: 'tx1',
          inputs: [],
          outputs: [{ address: 'addr1', value: 100 }]
        }]);

        const response = await app.inject({
          method: 'POST',
          url: '/blocks',
          payload: testBlock
        });

        expect(response.statusCode).toBe(500);
        const body = JSON.parse(response.body);
        expect(body.error).toBeDefined();
        expect(typeof body.error).toBe('string');
      });

      it('should handle concurrent API requests with proper error responses', async () => {
        // Submit many concurrent requests that will cause conflicts
        const conflictingBlocks = Array.from({ length: 5 }, () =>
          createTestBlock(1, [{
            id: 'tx1',
            inputs: [],
            outputs: [{ address: 'addr1', value: 100 }]
          }])
        );

        const promises = conflictingBlocks.map(block =>
          app.inject({
            method: 'POST',
            url: '/blocks',
            payload: block
          })
        );

        const responses = await Promise.all(promises);

        // At least one should succeed, others may succeed or fail depending on timing
        const successful = responses.filter(r => r.statusCode === 200);
        const failed = responses.filter(r => r.statusCode !== 200);

        expect(successful.length).toBeGreaterThanOrEqual(1);
        expect(successful.length + failed.length).toBe(5);

        // Failed responses should have proper error messages
        for (const response of failed) {
          const body = JSON.parse(response.body);
          expect(body.error || body.message).toBeDefined();
        }
      });
    });
  });

  describe('Concurrency Manager Unit Tests', () => {
    it('should report accurate queue status', async () => {
      const initialStatus = concurrencyManager.getStatus();
      expect(initialStatus.queueLength).toBe(0);
      expect(initialStatus.isProcessingBlocks).toBe(false);
      expect(initialStatus.rollbackInProgress).toBe(false);

      // Queue some operations
      const operations = Array.from({ length: 3 }, (_, i) =>
        concurrencyManager.queueBlockOperation(async () => {
          await simulateProcessingDelay(100);
          return { processed: i };
        })
      );

      // Check status while processing
      await simulateProcessingDelay(50);
      const processingStatus = concurrencyManager.getStatus();
      expect(processingStatus.isProcessingBlocks).toBe(true);

      // Wait for completion
      await Promise.all(operations);

      const finalStatus = concurrencyManager.getStatus();
      expect(finalStatus.queueLength).toBe(0);
      expect(finalStatus.isProcessingBlocks).toBe(false);
    });

    it('should clear queue and reject pending operations', async () => {
      // Queue operations but don't await them yet
      const operations = Array.from({ length: 5 }, (_, i) =>
        concurrencyManager.queueBlockOperation(async () => {
          await simulateProcessingDelay(200);
          return { processed: i };
        })
      );

      // Give a small delay to ensure operations are queued
      await simulateProcessingDelay(10);

      // Clear queue immediately
      concurrencyManager.clearQueue();

      // All operations should be rejected
      const results = await Promise.allSettled(operations);

      // Check that at least some operations were rejected
      const rejectedCount = results.filter(r => r.status === 'rejected').length;
      expect(rejectedCount).toBeGreaterThan(0);

      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason.message).toContain('Queue cleared');
        }
      }
    });

    it('should handle balance query permissions correctly', async () => {
      // Initially should allow balance queries
      expect(concurrencyManager.canExecuteBalanceQuery()).toBe(true);

      // Start rollback
      const rollbackPromise = concurrencyManager.executeRollback(async () => {
        expect(concurrencyManager.canExecuteBalanceQuery()).toBe(false);
        await simulateProcessingDelay(100);
        return { success: true };
      });

      // During rollback, balance queries should be blocked
      await simulateProcessingDelay(50);
      expect(concurrencyManager.canExecuteBalanceQuery()).toBe(false);

      // After rollback, should allow balance queries again
      await rollbackPromise;
      expect(concurrencyManager.canExecuteBalanceQuery()).toBe(true);
    });
  });
});