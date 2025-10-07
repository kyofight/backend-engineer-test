import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ErrorHandler, ErrorType, ErrorSeverity } from '../../src/services/error-handler.js';

describe('Error Handler Isolated Tests', () => {
  let errorHandler: ErrorHandler;

  beforeEach(() => {
    // Create a fresh instance for each test to avoid singleton issues
    errorHandler = new (ErrorHandler as any)();
  });

  describe('Error Statistics and Memory Management', () => {
    it('should provide error statistics for monitoring', async () => {
      // Generate various types of errors
      const errors = [
        new Error('Database connection failed'),
        new Error('Invalid transaction format'),
        new Error('Concurrent access violation'),
        new Error('Network timeout'),
        new Error('Validation failed')
      ];

      for (const error of errors) {
        errorHandler.createStructuredError(error, { operation: 'test' });
      }

      const stats = errorHandler.getErrorStatistics();
      
      expect(stats.totalErrors).toBe(5);
      expect(stats.errorsByType).toBeDefined();
      expect(stats.errorsBySeverity).toBeDefined();
      expect(stats.lastError).toBeDefined();
    });

    it('should clear old errors to prevent memory leaks', async () => {
      // Generate many errors
      for (let i = 0; i < 50; i++) {
        errorHandler.createStructuredError(
          new Error(`Test error ${i}`),
          { operation: 'test', additionalData: { index: i } }
        );
      }

      const statsBefore = errorHandler.getErrorStatistics();
      expect(statsBefore.totalErrors).toBe(50);

      // Clear old errors
      errorHandler.clearOldErrors();

      const statsAfter = errorHandler.getErrorStatistics();
      // Should still have recent errors (all are recent in this test)
      expect(statsAfter.totalErrors).toBeGreaterThan(0);
    });

    it('should track error counts by type and severity', async () => {
      // Generate specific error types
      errorHandler.createStructuredError(
        new Error('Database connection failed'),
        { operation: 'test1' }
      );
      errorHandler.createStructuredError(
        new Error('Invalid block height'),
        { operation: 'test2' }
      );
      errorHandler.createStructuredError(
        new Error('Database query failed'),
        { operation: 'test3' }
      );

      const stats = errorHandler.getErrorStatistics();
      
      expect(stats.errorsByType[ErrorType.DATABASE_ERROR]).toBe(2);
      expect(stats.errorsByType[ErrorType.VALIDATION_ERROR]).toBe(1);
      expect(stats.errorsBySeverity[ErrorSeverity.HIGH]).toBe(2);
      expect(stats.errorsBySeverity[ErrorSeverity.MEDIUM]).toBe(1);
    });

    it('should limit error log size to prevent memory issues', async () => {
      // Generate more errors than the max log size (1000)
      for (let i = 0; i < 1200; i++) {
        errorHandler.createStructuredError(
          new Error(`Test error ${i}`),
          { operation: 'test', additionalData: { index: i } }
        );
      }

      const stats = errorHandler.getErrorStatistics();
      
      // Should be capped at max log size
      expect(stats.totalErrors).toBeLessThanOrEqual(1000);
    });
  });

  describe('Error Classification', () => {
    it('should classify database errors correctly', async () => {
      const databaseErrors = [
        'Database connection failed',
        'Query execution failed',
        'Transaction rollback error',
        'Connection timeout'
      ];

      for (const errorMessage of databaseErrors) {
        const structuredError = errorHandler.createStructuredError(
          new Error(errorMessage),
          { operation: 'test' }
        );

        expect(structuredError.type).toBe(ErrorType.DATABASE_ERROR);
        expect(structuredError.severity).toBe(ErrorSeverity.HIGH);
        expect(structuredError.retryable).toBe(true);
        expect(structuredError.recoverable).toBe(true);
      }
    });

    it('should classify validation errors correctly', async () => {
      const validationErrors = [
        'Invalid block format',
        'Validation failed',
        'Required field missing',
        'Invalid address format'
      ];

      for (const errorMessage of validationErrors) {
        const structuredError = errorHandler.createStructuredError(
          new Error(errorMessage),
          { operation: 'test' }
        );

        expect(structuredError.type).toBe(ErrorType.VALIDATION_ERROR);
        expect(structuredError.severity).toBe(ErrorSeverity.MEDIUM);
        expect(structuredError.retryable).toBe(false);
        expect(structuredError.recoverable).toBe(false);
      }
    });

    it('should classify concurrency errors correctly', async () => {
      const concurrencyErrors = [
        'Concurrent access detected',
        'Lock acquisition failed',
        'Queue overflow'
      ];

      for (const errorMessage of concurrencyErrors) {
        const structuredError = errorHandler.createStructuredError(
          new Error(errorMessage),
          { operation: 'test' }
        );

        expect(structuredError.type).toBe(ErrorType.CONCURRENCY_ERROR);
        expect(structuredError.severity).toBe(ErrorSeverity.MEDIUM);
        expect(structuredError.retryable).toBe(true);
        expect(structuredError.recoverable).toBe(true);
      }
    });

    it('should classify business logic errors correctly', async () => {
      const businessLogicErrors = [
        'UTXO not found',
        'Insufficient balance',
        'Transaction already spent',
        'Balance calculation error'
      ];

      for (const errorMessage of businessLogicErrors) {
        const structuredError = errorHandler.createStructuredError(
          new Error(errorMessage),
          { operation: 'test' }
        );

        expect(structuredError.type).toBe(ErrorType.BUSINESS_LOGIC_ERROR);
        expect(structuredError.severity).toBe(ErrorSeverity.HIGH);
        expect(structuredError.retryable).toBe(false);
        expect(structuredError.recoverable).toBe(false);
      }
    });

    it('should classify network errors correctly', async () => {
      const networkErrors = [
        'Network timeout',
        'Network unreachable',
        'Request timeout'
      ];

      for (const errorMessage of networkErrors) {
        const structuredError = errorHandler.createStructuredError(
          new Error(errorMessage),
          { operation: 'test' }
        );

        expect(structuredError.type).toBe(ErrorType.NETWORK_ERROR);
        expect(structuredError.severity).toBe(ErrorSeverity.MEDIUM);
        expect(structuredError.retryable).toBe(true);
        expect(structuredError.recoverable).toBe(true);
      }
    });
  });

  describe('Retry Logic', () => {
    it('should implement exponential backoff correctly', async () => {
      let callCount = 0;
      const callTimes: number[] = [];

      const failingOperation = async () => {
        callTimes.push(Date.now());
        callCount++;
        if (callCount <= 3) {
          throw new Error('Database connection failed'); // Retryable error
        }
        return { success: true };
      };

      const result = await errorHandler.executeWithRetry(
        failingOperation,
        { operation: 'testOperation' },
        { 
          maxRetries: 3, 
          retryDelayMs: 50,
          backoffMultiplier: 2 
        }
      );

      expect(result.success).toBe(true);
      expect(callCount).toBe(4);
      
      // Verify exponential backoff timing (with tolerance)
      expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(40);
      expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(90);
      expect(callTimes[3] - callTimes[2]).toBeGreaterThanOrEqual(190);
    });

    it('should not retry non-retryable errors', async () => {
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

    it('should respect maximum retry limit', async () => {
      let callCount = 0;

      const alwaysFailingOperation = async () => {
        callCount++;
        throw new Error('Database connection failed'); // Retryable error
      };

      try {
        await errorHandler.executeWithRetry(
          alwaysFailingOperation,
          { operation: 'testOperation' },
          { maxRetries: 2, retryDelayMs: 10 }
        );
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(callCount).toBe(3); // Initial attempt + 2 retries
      }
    });
  });

  describe('Database Transaction Handling', () => {
    it('should handle successful transaction rollback', async () => {
      const mockTransaction = {
        rollback: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined)
      };

      const processingError = new Error('Database connection failed');
      
      const structuredError = await errorHandler.handleDatabaseError(
        processingError,
        mockTransaction,
        { operation: 'processBlock', blockHeight: 1 }
      );

      expect(structuredError.type).toBe(ErrorType.DATABASE_ERROR);
      expect(structuredError.recoverable).toBe(true);
      expect(structuredError.context.additionalData?.transactionRolledBack).toBe(true);
      expect(mockTransaction.rollback).toHaveBeenCalled();
    });

    it('should handle failed transaction rollback', async () => {
      const mockTransaction = {
        rollback: vi.fn().mockRejectedValue(new Error('Rollback failed')),
        commit: vi.fn().mockResolvedValue(undefined)
      };

      const processingError = new Error('Database connection failed');
      
      const structuredError = await errorHandler.handleDatabaseError(
        processingError,
        mockTransaction,
        { operation: 'processBlock', blockHeight: 1 }
      );

      expect(structuredError.type).toBe(ErrorType.DATABASE_ERROR);
      expect(structuredError.context.additionalData?.transactionRollbackFailed).toBe(true);
      expect(mockTransaction.rollback).toHaveBeenCalled();
    });

    it('should handle null transaction gracefully', async () => {
      const processingError = new Error('Database connection failed');
      
      const structuredError = await errorHandler.handleDatabaseError(
        processingError,
        null,
        { operation: 'processBlock', blockHeight: 1 }
      );

      expect(structuredError.type).toBe(ErrorType.DATABASE_ERROR);
      expect(structuredError.recoverable).toBe(true);
    });
  });
});