/**
 * Concurrency Manager for blockchain indexer
 * Ensures sequential block processing while allowing concurrent balance queries
 */

export interface QueuedOperation<T> {
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export class ConcurrencyManager {
  private blockProcessingQueue: QueuedOperation<any>[] = [];
  private isProcessingBlocks = false;
  private rollbackInProgress = false;

  /**
   * Queue a block processing operation to ensure sequential execution
   * @param operation The block processing function to execute
   * @returns Promise that resolves when the operation completes
   */
  async queueBlockOperation<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Add operation to queue
      this.blockProcessingQueue.push({
        operation,
        resolve,
        reject
      });

      // Process queue if not already processing
      this.processQueue();
    });
  }

  /**
   * Execute a rollback operation with exclusive access
   * @param operation The rollback function to execute
   * @returns Promise that resolves when the rollback completes
   */
  async executeRollback<T>(operation: () => Promise<T>): Promise<T> {
    // Wait for any ongoing block processing to complete
    while (this.isProcessingBlocks) {
      await this.sleep(10);
    }

    // Set rollback flag to prevent new block processing
    this.rollbackInProgress = true;

    try {
      return await operation();
    } finally {
      this.rollbackInProgress = false;
      // Resume processing any queued operations
      this.processQueue();
    }
  }

  /**
   * Check if balance queries can proceed safely
   * Balance queries are allowed during block processing but not during rollbacks
   * @returns true if balance queries are safe to execute
   */
  canExecuteBalanceQuery(): boolean {
    return !this.rollbackInProgress;
  }

  /**
   * Process the queue of block operations sequentially
   */
  private async processQueue(): Promise<void> {
    // Don't start processing if already processing or rollback in progress
    if (this.isProcessingBlocks || this.rollbackInProgress) {
      return;
    }

    // Don't process if queue is empty
    if (this.blockProcessingQueue.length === 0) {
      return;
    }

    this.isProcessingBlocks = true;

    try {
      while (this.blockProcessingQueue.length > 0 && !this.rollbackInProgress) {
        const queuedOperation = this.blockProcessingQueue.shift();
        
        if (queuedOperation) {
          try {
            const result = await queuedOperation.operation();
            queuedOperation.resolve(result);
          } catch (error) {
            queuedOperation.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
    } finally {
      this.isProcessingBlocks = false;
    }
  }

  /**
   * Utility function to sleep for a specified number of milliseconds
   * @param ms Number of milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current queue status for monitoring
   * @returns Object with queue status information
   */
  getStatus() {
    return {
      queueLength: this.blockProcessingQueue.length,
      isProcessingBlocks: this.isProcessingBlocks,
      rollbackInProgress: this.rollbackInProgress
    };
  }

  /**
   * Clear the queue (for testing or emergency situations)
   * This will reject all queued operations
   */
  clearQueue(): void {
    const error = new Error('Queue cleared - operation cancelled');
    
    while (this.blockProcessingQueue.length > 0) {
      const operation = this.blockProcessingQueue.shift();
      if (operation) {
        operation.reject(error);
      }
    }
  }
}

// Singleton instance for application-wide use
export const concurrencyManager = new ConcurrencyManager();