import { DatabaseConnection, runMigrations } from '@database/index';
import { testDatabaseSetup } from '@database/test-setup';
import { errorHandler } from '@services/error-handler';
import type { AppConfig } from '@config/app.config';

export interface DatabaseStatus {
  connected: boolean;
  lastAttempt: Date | null;
  lastSuccess: Date | null;
  lastError: string | null;
  connectionAttempts: number;
  migrationStatus: 'pending' | 'running' | 'completed' | 'failed';
}

export interface DatabaseManagerConfig {
  maxReconnectAttempts: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  reconnectBackoffMultiplier: number;
  healthCheckIntervalMs: number;
  connectionTimeoutMs: number;
}

const DEFAULT_DB_MANAGER_CONFIG: DatabaseManagerConfig = {
  maxReconnectAttempts: -1, // Infinite retries
  reconnectBaseDelayMs: 1000,
  reconnectMaxDelayMs: 30000,
  reconnectBackoffMultiplier: 1.5,
  healthCheckIntervalMs: 30000, // 30 seconds
  connectionTimeoutMs: 10000 // 10 seconds
};

export class DatabaseManager {
  private db: DatabaseConnection | null = null;
  private config: AppConfig;
  private managerConfig: DatabaseManagerConfig;
  private status: DatabaseStatus;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private connectionPromise: Promise<DatabaseConnection> | null = null;
  private reconnectAttempts = 0;

  constructor(config: AppConfig, managerConfig: Partial<DatabaseManagerConfig> = {}) {
    this.config = config;
    this.managerConfig = { ...DEFAULT_DB_MANAGER_CONFIG, ...managerConfig };
    this.status = {
      connected: false,
      lastAttempt: null,
      lastSuccess: null,
      lastError: null,
      connectionAttempts: 0,
      migrationStatus: 'pending'
    };
  }

  // Get current database connection (may be null)
  getConnection(): DatabaseConnection | null {
    return this.db;
  }

  // Get database status
  getStatus(): DatabaseStatus {
    return { ...this.status };
  }

  // Check if database is available
  isConnected(): boolean {
    return this.status.connected && this.db !== null;
  }

  // Get connection with automatic retry (returns promise that resolves when connected)
  async getConnectionWithRetry(): Promise<DatabaseConnection> {
    if (this.isConnected() && this.db) {
      return this.db;
    }

    // If there's already a connection attempt in progress, wait for it
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    // Start new connection attempt
    this.connectionPromise = this.connectWithRetry();

    try {
      const connection = await this.connectionPromise;
      this.connectionPromise = null;
      return connection;
    } catch (error) {
      this.connectionPromise = null;

      // Schedule reconnection for future attempts
      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }

      throw error;
    }
  }

  // Initialize database manager (non-blocking)
  async initialize(): Promise<void> {
    console.log('Initializing database manager...');

    // Start connection attempt in background
    this.startConnectionAttempt();

    // Start health check timer
    this.startHealthCheck();

    console.log('Database manager initialized (connection will be established in background)');
  }

  // Start connection attempt in background
  private startConnectionAttempt(): void {
    if (this.isShuttingDown) return;

    // Don't start new attempt if one is already in progress
    if (this.connectionPromise) return;

    this.connectionPromise = this.connectWithRetry()
      .then((connection) => {
        this.connectionPromise = null;
        return connection;
      })
      .catch((error) => {
        this.connectionPromise = null;

        // If connection failed and we're not shutting down, schedule another attempt
        if (!this.isShuttingDown) {
          console.log('Connection attempt failed, scheduling retry...');
          this.scheduleReconnect();
        }

        throw error;
      });
  }

  // Attempt to connect with retry logic (limited retries per attempt)
  private async connectWithRetry(): Promise<DatabaseConnection> {
    const maxImmediateRetries = 3; // Limit immediate retries, rely on scheduleReconnect for long-term
    let attempt = 0;

    while (!this.isShuttingDown && attempt < maxImmediateRetries) {
      attempt++;
      this.status.connectionAttempts++;
      this.status.lastAttempt = new Date();

      try {
        console.log(`Database connection attempt ${this.status.connectionAttempts}...`);

        // Create new connection
        const db = await this.createConnection();

        // Run migrations if needed
        await this.runMigrations();

        // Validate setup
        await this.validateSetup();

        // Success!
        this.db = db;
        this.status.connected = true;
        this.status.lastSuccess = new Date();
        this.status.lastError = null;
        this.status.migrationStatus = 'completed';

        // Reset reconnect attempts counter on successful connection
        this.reconnectAttempts = 0;

        console.log(`Database connected successfully on attempt ${this.status.connectionAttempts}`);

        // Setup connection monitoring
        this.setupConnectionMonitoring();

        return db;

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.status.lastError = errorMessage;
        this.status.connected = false;

        console.warn(`Database connection attempt ${this.status.connectionAttempts} failed: ${errorMessage}`);

        // Log structured error
        errorHandler.createStructuredError(
          error instanceof Error ? error : new Error(errorMessage),
          {
            operation: 'database_connection',
            additionalData: {
              attempt: this.status.connectionAttempts,
              databaseUrl: this.config.databaseUrl.replace(/:[^:@]*@/, ':***@') // Hide password
            }
          }
        );

        // If this is not the last immediate retry, wait a short time before next attempt
        if (attempt < maxImmediateRetries && !this.isShuttingDown) {
          const delay = Math.min(1000 * attempt, 5000); // Short delays for immediate retries
          console.log(`Retrying database connection in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    // If we get here, all immediate retries failed
    if (this.isShuttingDown) {
      throw new Error('Database connection aborted due to shutdown');
    }

    throw new Error(`Failed to connect to database after ${maxImmediateRetries} immediate attempts. Last error: ${this.status.lastError}`);
  }

  // Create database connection with timeout
  private async createConnection(): Promise<DatabaseConnection> {
    const db = DatabaseConnection.createFromUrl(this.config.databaseUrl);
    let connectionClosed = false;

    // Test connection with timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Database connection timeout')), this.managerConfig.connectionTimeoutMs);
    });

    const queryPromise = db.getPool().query('SELECT 1');

    try {
      await Promise.race([queryPromise, timeoutPromise]);
      return db;
    } catch (error) {
      // Clean up connection on failure (only if not already closed)
      if (!connectionClosed) {
        connectionClosed = true;
        try {
          await db.close();
        } catch (closeError) {
          // Ignore cleanup errors - they're not critical
          const errorMessage = closeError instanceof Error ? closeError.message : String(closeError);
          console.debug('Connection cleanup warning:', errorMessage);
        }
      }
      throw error;
    }
  }

  // Run database migrations
  private async runMigrations(): Promise<void> {
    this.status.migrationStatus = 'running';

    try {
      console.log('Running database migrations...');
      await runMigrations();
      console.log('Database migrations completed successfully');
      this.status.migrationStatus = 'completed';
    } catch (error) {
      this.status.migrationStatus = 'failed';
      throw new Error(`Database migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Validate database setup
  private async validateSetup(): Promise<void> {
    console.log('Validating database setup...');

    const setupSuccess = await testDatabaseSetup(this.config.databaseUrl);
    if (!setupSuccess) {
      throw new Error('Database setup validation failed');
    }

    console.log('Database setup validation completed successfully');
  }

  // Setup connection monitoring
  private setupConnectionMonitoring(): void {
    if (!this.db) return;

    // Monitor for connection errors
    this.db.getPool().on('error', (error) => {
      console.error('Database pool error:', error);
      this.handleConnectionLoss(error);
    });

    // Monitor for connection removal
    this.db.getPool().on('remove', () => {
      console.warn('Database connection removed from pool');
    });
  }

  // Handle connection loss
  private handleConnectionLoss(error: Error): void {
    console.warn('Database connection lost:', error.message);

    this.status.connected = false;
    this.status.lastError = error.message;

    // Log structured error
    errorHandler.createStructuredError(error, {
      operation: 'database_connection_lost',
      additionalData: {
        databaseUrl: this.config.databaseUrl.replace(/:[^:@]*@/, ':***@')
      }
    });

    // Start reconnection attempt
    this.scheduleReconnect();
  }

  // Schedule reconnection attempt
  private scheduleReconnect(): void {
    if (this.isShuttingDown || this.reconnectTimer || this.connectionPromise) {
      return;
    }

    // Check if we've exceeded max reconnect attempts (if configured)
    if (this.managerConfig.maxReconnectAttempts > 0 &&
      this.reconnectAttempts >= this.managerConfig.maxReconnectAttempts) {
      console.error(`Maximum reconnection attempts (${this.managerConfig.maxReconnectAttempts}) exceeded. Stopping reconnection attempts.`);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.calculateReconnectDelay(this.reconnectAttempts);
    console.log(`Scheduling database reconnection attempt ${this.reconnectAttempts} in ${delay}ms...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startConnectionAttempt();
    }, delay);
  }

  // Start periodic health checks
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.managerConfig.healthCheckIntervalMs);
  }

  // Perform health check
  private async performHealthCheck(): Promise<void> {
    if (this.isShuttingDown || !this.db) {
      return;
    }

    try {
      await this.db.getPool().query('SELECT 1');

      // Update status if we weren't connected before
      if (!this.status.connected) {
        this.status.connected = true;
        this.status.lastSuccess = new Date();
        this.status.lastError = null;
        console.log('Database connection restored');
      }
    } catch (error) {
      if (this.status.connected) {
        console.warn('Database health check failed:', error);
        this.handleConnectionLoss(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  // Calculate reconnection delay with exponential backoff
  private calculateReconnectDelay(attempt: number): number {
    const delay = this.managerConfig.reconnectBaseDelayMs *
      Math.pow(this.managerConfig.reconnectBackoffMultiplier, attempt - 1);
    return Math.min(delay, this.managerConfig.reconnectMaxDelayMs);
  }

  // Sleep utility
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Shutdown database manager
  async shutdown(): Promise<void> {
    console.log('Shutting down database manager...');

    this.isShuttingDown = true;

    // Clear timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Close database connection
    if (this.db) {
      try {
        await this.db.close();
        console.log('Database connection closed');
      } catch (error) {
        console.error('Error closing database connection:', error);
      }
      this.db = null;
    }

    this.status.connected = false;
    console.log('Database manager shutdown completed');
  }
}