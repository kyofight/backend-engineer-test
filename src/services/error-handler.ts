/**
 * Comprehensive error handling and recovery system
 * Provides structured error handling, logging, and recovery mechanisms
 */

export enum ErrorType {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  CONCURRENCY_ERROR = 'CONCURRENCY_ERROR',
  BUSINESS_LOGIC_ERROR = 'BUSINESS_LOGIC_ERROR',
  SYSTEM_ERROR = 'SYSTEM_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR'
}

export enum ErrorSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL'
}

export interface ErrorContext {
  operation: string;
  blockHeight?: number;
  address?: string;
  transactionId?: string;
  additionalData?: Record<string, any>;
}

export interface StructuredError {
  type: ErrorType;
  severity: ErrorSeverity;
  message: string;
  originalError?: Error;
  context: ErrorContext;
  timestamp: Date;
  recoverable: boolean;
  retryable: boolean;
}

export interface ErrorRecoveryStrategy {
  maxRetries: number;
  retryDelayMs: number;
  backoffMultiplier: number;
  shouldRetry: (error: StructuredError, attemptNumber: number) => boolean;
}

export class ErrorHandler {
  private static instance: ErrorHandler;
  private errorLog: StructuredError[] = [];
  private maxLogSize = 1000;

  private constructor() { }

  static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }
    return ErrorHandler.instance;
  }

  /**
   * Create a structured error from a raw error
   * @param error The original error
   * @param context Context information about where the error occurred
   * @returns StructuredError with classification and metadata
   */
  createStructuredError(
    error: Error | string,
    context: ErrorContext
  ): StructuredError {
    const errorMessage = error instanceof Error ? error.message : error;
    const originalError = error instanceof Error ? error : undefined;

    // Classify error type and severity based on message and context
    const { type, severity, recoverable, retryable } = this.classifyError(errorMessage, context);

    const structuredError: StructuredError = {
      type,
      severity,
      message: errorMessage,
      originalError,
      context,
      timestamp: new Date(),
      recoverable,
      retryable
    };

    // Log the error
    this.logError(structuredError);

    return structuredError;
  }

  /**
   * Execute an operation with automatic retry and error handling
   * @param operation The operation to execute
   * @param context Context information for error handling
   * @param strategy Optional retry strategy (uses default if not provided)
   * @returns Promise that resolves with the operation result
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    context: ErrorContext,
    strategy?: Partial<ErrorRecoveryStrategy>
  ): Promise<T> {
    const defaultStrategy: ErrorRecoveryStrategy = {
      maxRetries: 3,
      retryDelayMs: 1000,
      backoffMultiplier: 2,
      shouldRetry: (error, attemptNumber) => error.retryable && attemptNumber < 3
    };

    const finalStrategy = { ...defaultStrategy, ...strategy };
    let lastError: StructuredError | null = null;

    for (let attempt = 0; attempt <= finalStrategy.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const structuredError = this.createStructuredError(
          error instanceof Error ? error : new Error(String(error)),
          { ...context, additionalData: { attempt: attempt + 1 } }
        );

        lastError = structuredError;

        // Check if we should retry
        if (attempt < finalStrategy.maxRetries && finalStrategy.shouldRetry(structuredError, attempt)) {
          const delay = finalStrategy.retryDelayMs * Math.pow(finalStrategy.backoffMultiplier, attempt);
          await this.sleep(delay);
          continue;
        }

        // No more retries, throw the error
        throw this.createRecoveryError(structuredError);
      }
    }

    // This should never be reached, but TypeScript requires it
    throw this.createRecoveryError(lastError!);
  }

  /**
   * Handle database transaction errors with automatic rollback
   * @param error The database error
   * @param transaction The database transaction to rollback
   * @param context Context information
   * @returns StructuredError with recovery information
   */
  async handleDatabaseError(
    error: Error,
    transaction: any, // DatabaseTransaction type
    context: ErrorContext
  ): Promise<StructuredError> {
    const structuredError = this.createStructuredError(error, {
      ...context,
      operation: `${context.operation} (database transaction)`
    });

    // Attempt to rollback transaction if it's still active
    try {
      if (transaction && typeof transaction.rollback === 'function') {
        await transaction.rollback();
        structuredError.context.additionalData = {
          ...structuredError.context.additionalData,
          transactionRolledBack: true
        };
      }
    } catch (rollbackError) {
      // Log rollback failure but don't throw - original error is more important
      this.logError(this.createStructuredError(
        rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
        { operation: 'transaction_rollback', additionalData: { originalError: error.message } }
      ));

      structuredError.context.additionalData = {
        ...structuredError.context.additionalData,
        transactionRollbackFailed: true
      };
    }

    return structuredError;
  }

  /**
   * Get error statistics for monitoring
   * @returns Object with error statistics
   */
  getErrorStatistics() {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const recentErrors = this.errorLog.filter(e => e.timestamp >= oneHourAgo);
    const dailyErrors = this.errorLog.filter(e => e.timestamp >= oneDayAgo);

    const errorsByType = this.errorLog.reduce((acc, error) => {
      acc[error.type] = (acc[error.type] || 0) + 1;
      return acc;
    }, {} as Record<ErrorType, number>);

    const errorsBySeverity = this.errorLog.reduce((acc, error) => {
      acc[error.severity] = (acc[error.severity] || 0) + 1;
      return acc;
    }, {} as Record<ErrorSeverity, number>);

    return {
      totalErrors: this.errorLog.length,
      recentErrors: recentErrors.length,
      dailyErrors: dailyErrors.length,
      errorsByType,
      errorsBySeverity,
      lastError: this.errorLog[this.errorLog.length - 1] || null
    };
  }

  /**
   * Clear old errors from the log to prevent memory issues
   */
  clearOldErrors(): void {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    this.errorLog = this.errorLog.filter(error => error.timestamp >= oneDayAgo);
  }

  /**
   * Classify an error based on its message and context
   * @param message Error message
   * @param context Error context
   * @returns Classification information
   */
  private classifyError(message: string, context: ErrorContext) {
    const lowerMessage = message.toLowerCase();

    // Business logic errors (check first to avoid conflicts)
    if (lowerMessage.includes('balance') ||
      lowerMessage.includes('utxo') ||
      lowerMessage.includes('insufficient balance') ||
      lowerMessage.includes('transaction already spent') ||
      lowerMessage.includes('balance calculation error') ||
      lowerMessage.includes('utxo not found')) {
      return {
        type: ErrorType.BUSINESS_LOGIC_ERROR,
        severity: ErrorSeverity.HIGH,
        recoverable: false,
        retryable: false
      };
    }

    // Database errors (more specific patterns)
    if (lowerMessage.includes('database') ||
      lowerMessage.includes('connection failed') ||
      lowerMessage.includes('connection timeout') ||
      lowerMessage.includes('query') ||
      lowerMessage.includes('transaction rollback') ||
      lowerMessage.includes('database connection')) {
      return {
        type: ErrorType.DATABASE_ERROR,
        severity: ErrorSeverity.HIGH,
        recoverable: true,
        retryable: true
      };
    }

    // Validation errors
    if (lowerMessage.includes('validation') ||
      lowerMessage.includes('invalid') ||
      lowerMessage.includes('must be') ||
      lowerMessage.includes('required') ||
      lowerMessage.includes('format')) {
      return {
        type: ErrorType.VALIDATION_ERROR,
        severity: ErrorSeverity.MEDIUM,
        recoverable: false,
        retryable: false
      };
    }

    // Concurrency errors
    if (lowerMessage.includes('concurrent') ||
      lowerMessage.includes('lock') ||
      lowerMessage.includes('queue')) {
      return {
        type: ErrorType.CONCURRENCY_ERROR,
        severity: ErrorSeverity.MEDIUM,
        recoverable: true,
        retryable: true
      };
    }

    // Network errors
    if (lowerMessage.includes('network') ||
      lowerMessage.includes('timeout') ||
      lowerMessage.includes('connection refused') ||
      lowerMessage.includes('unreachable')) {
      return {
        type: ErrorType.NETWORK_ERROR,
        severity: ErrorSeverity.MEDIUM,
        recoverable: true,
        retryable: true
      };
    }

    // Default to system error
    return {
      type: ErrorType.SYSTEM_ERROR,
      severity: ErrorSeverity.HIGH,
      recoverable: true,
      retryable: false
    };
  }

  /**
   * Log a structured error
   * @param error The structured error to log
   */
  private logError(error: StructuredError): void {
    // Add to in-memory log
    this.errorLog.push(error);

    // Trim log if it gets too large
    if (this.errorLog.length > this.maxLogSize) {
      this.errorLog = this.errorLog.slice(-this.maxLogSize);
    }

    // Log to console with appropriate level based on severity
    const logData = {
      type: error.type,
      severity: error.severity,
      message: error.message,
      context: error.context,
      timestamp: error.timestamp.toISOString(),
      recoverable: error.recoverable,
      retryable: error.retryable
    };

    switch (error.severity) {
      case ErrorSeverity.CRITICAL:
        console.error('CRITICAL ERROR:', logData);
        break;
      case ErrorSeverity.HIGH:
        console.error('HIGH SEVERITY ERROR:', logData);
        break;
      case ErrorSeverity.MEDIUM:
        console.warn('MEDIUM SEVERITY ERROR:', logData);
        break;
      case ErrorSeverity.LOW:
        console.info('LOW SEVERITY ERROR:', logData);
        break;
    }
  }

  /**
   * Create a recovery error that includes the structured error information
   * @param structuredError The structured error
   * @returns Error with structured information
   */
  private createRecoveryError(structuredError: StructuredError): Error {
    const error = new Error(structuredError.message);
    (error as any).structuredError = structuredError;
    return error;
  }

  /**
   * Utility function to sleep for a specified number of milliseconds
   * @param ms Number of milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const errorHandler = ErrorHandler.getInstance();