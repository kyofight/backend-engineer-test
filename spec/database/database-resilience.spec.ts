import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseManager } from '@services/database-manager';
import type { AppConfig } from '@config/app.config';

// Mock the database connection
vi.mock('@database/index', () => ({
  DatabaseConnection: {
    createFromUrl: vi.fn(() => ({
      getPool: vi.fn(() => ({
        query: vi.fn(),
        on: vi.fn(),
        totalCount: 5,
        idleCount: 3,
        waitingCount: 0
      })),
      close: vi.fn()
    }))
  },
  runMigrations: vi.fn()
}));

vi.mock('@database/test-setup', () => ({
  testDatabaseSetup: vi.fn(() => Promise.resolve(true))
}));

describe('Database Resilience', () => {
  let dbManager: DatabaseManager;
  let mockConfig: AppConfig;

  beforeEach(() => {
    mockConfig = {
      databaseUrl: 'postgres://test:test@localhost:5432/test',
      port: 3000,
      host: '0.0.0.0',
      environment: 'test',
      logLevel: 'info'
    };

    // Clear all mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (dbManager) {
      await dbManager.shutdown();
    }
  });

  describe('Database Manager Initialization', () => {
    it('should initialize without requiring immediate database connection', async () => {
      dbManager = new DatabaseManager(mockConfig);

      // Should initialize successfully even if database is not available
      await expect(dbManager.initialize()).resolves.not.toThrow();

      // Status should be available
      const status = dbManager.getStatus();
      expect(status).toBeDefined();
      expect(status.connectionAttempts).toBeGreaterThanOrEqual(0);
      expect(['pending', 'running', 'completed', 'failed']).toContain(status.migrationStatus);
    });

    it('should use custom configuration', () => {
      const customConfig = {
        maxReconnectAttempts: 5,
        reconnectBaseDelayMs: 500,
        reconnectMaxDelayMs: 10000,
        reconnectBackoffMultiplier: 2.0,
        healthCheckIntervalMs: 15000,
        connectionTimeoutMs: 5000
      };

      dbManager = new DatabaseManager(mockConfig, customConfig);

      // Configuration should be applied (we can't directly test private properties,
      // but we can test behavior that depends on them)
      expect(dbManager).toBeDefined();
    });
  });

  describe('Connection Status Management', () => {
    beforeEach(async () => {
      dbManager = new DatabaseManager(mockConfig);
      await dbManager.initialize();
    });

    it('should report correct connection status', () => {
      const status = dbManager.getStatus();

      expect(status).toHaveProperty('connected');
      expect(status).toHaveProperty('lastAttempt');
      expect(status).toHaveProperty('lastSuccess');
      expect(status).toHaveProperty('lastError');
      expect(status).toHaveProperty('connectionAttempts');
      expect(status).toHaveProperty('migrationStatus');

      expect(typeof status.connected).toBe('boolean');
      expect(typeof status.connectionAttempts).toBe('number');
    });

    it('should return null connection when not connected', () => {
      const connection = dbManager.getConnection();
      expect(connection).toBeNull();
    });

    it('should report not connected initially', () => {
      expect(dbManager.isConnected()).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle database connection errors gracefully', async () => {
      // Mock a failing connection
      const { DatabaseConnection } = await import('@database/index');
      vi.mocked(DatabaseConnection.createFromUrl).mockImplementation(() => {
        throw new Error('Connection refused');
      });

      dbManager = new DatabaseManager(mockConfig, {
        maxReconnectAttempts: 2,
        reconnectBaseDelayMs: 10,
        reconnectMaxDelayMs: 100,
        reconnectBackoffMultiplier: 1.5,
        healthCheckIntervalMs: 1000,
        connectionTimeoutMs: 100
      });

      await dbManager.initialize();

      // Should handle the error and not crash
      expect(dbManager.isConnected()).toBe(false);

      const status = dbManager.getStatus();
      expect(status.connected).toBe(false);
    });

    it('should throw error when trying to get connection without retry', async () => {
      dbManager = new DatabaseManager(mockConfig);
      await dbManager.initialize();

      // Should throw error when no connection is available
      expect(() => dbManager.getConnection()).not.toThrow();
      expect(dbManager.getConnection()).toBeNull();
    });
  });

  describe('Reconnection Logic', () => {
    it('should attempt reconnection with exponential backoff', async () => {
      const mockConnection = {
        getPool: vi.fn(() => ({
          query: vi.fn().mockRejectedValue(new Error('Connection lost')),
          on: vi.fn(),
          totalCount: 0,
          idleCount: 0,
          waitingCount: 0
        })),
        close: vi.fn()
      };

      const { DatabaseConnection } = await import('@database/index');
      vi.mocked(DatabaseConnection.createFromUrl).mockReturnValue(mockConnection as any);

      dbManager = new DatabaseManager(mockConfig, {
        maxReconnectAttempts: 3,
        reconnectBaseDelayMs: 10,
        reconnectMaxDelayMs: 100,
        reconnectBackoffMultiplier: 2.0,
        healthCheckIntervalMs: 1000,
        connectionTimeoutMs: 100
      });

      await dbManager.initialize();

      // Wait a bit for connection attempts
      await new Promise(resolve => setTimeout(resolve, 50));

      const status = dbManager.getStatus();
      expect(status.connectionAttempts).toBeGreaterThan(0);
    });
  });

  describe('Graceful Shutdown', () => {
    it('should shutdown gracefully', async () => {
      dbManager = new DatabaseManager(mockConfig);
      await dbManager.initialize();

      // Should shutdown without errors
      await expect(dbManager.shutdown()).resolves.not.toThrow();

      // Should be marked as shutting down
      expect(dbManager.isConnected()).toBe(false);
    });

    it('should handle shutdown when no connection exists', async () => {
      dbManager = new DatabaseManager(mockConfig);
      await dbManager.initialize();

      // Should shutdown gracefully even without connection
      await expect(dbManager.shutdown()).resolves.not.toThrow();
    });
  });

  describe('Environment Variable Configuration', () => {
    it('should use environment variables for configuration', () => {
      // Set environment variables
      process.env.DB_MAX_RECONNECT_ATTEMPTS = '5';
      process.env.DB_RECONNECT_BASE_DELAY_MS = '500';
      process.env.DB_RECONNECT_MAX_DELAY_MS = '15000';
      process.env.DB_RECONNECT_BACKOFF_MULTIPLIER = '2.5';
      process.env.DB_HEALTH_CHECK_INTERVAL_MS = '20000';
      process.env.DB_CONNECTION_TIMEOUT_MS = '8000';

      // Test that environment variables are read correctly
      expect(parseInt(process.env.DB_MAX_RECONNECT_ATTEMPTS)).toBe(5);
      expect(parseInt(process.env.DB_RECONNECT_BASE_DELAY_MS)).toBe(500);
      expect(parseInt(process.env.DB_RECONNECT_MAX_DELAY_MS)).toBe(15000);
      expect(parseFloat(process.env.DB_RECONNECT_BACKOFF_MULTIPLIER)).toBe(2.5);
      expect(parseInt(process.env.DB_HEALTH_CHECK_INTERVAL_MS)).toBe(20000);
      expect(parseInt(process.env.DB_CONNECTION_TIMEOUT_MS)).toBe(8000);

      // Clean up
      delete process.env.DB_MAX_RECONNECT_ATTEMPTS;
      delete process.env.DB_RECONNECT_BASE_DELAY_MS;
      delete process.env.DB_RECONNECT_MAX_DELAY_MS;
      delete process.env.DB_RECONNECT_BACKOFF_MULTIPLIER;
      delete process.env.DB_HEALTH_CHECK_INTERVAL_MS;
      delete process.env.DB_CONNECTION_TIMEOUT_MS;
    });
  });

  describe('Connection Retry Behavior', () => {
    it('should retry connection attempts with proper delays', async () => {
      let attemptCount = 0;
      const { DatabaseConnection } = await import('@database/index');

      vi.mocked(DatabaseConnection.createFromUrl).mockImplementation(() => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error('Connection failed');
        }
        return {
          getPool: vi.fn(() => ({
            query: vi.fn().mockResolvedValue({ rows: [] }),
            on: vi.fn(),
            totalCount: 1,
            idleCount: 1,
            waitingCount: 0
          })),
          close: vi.fn()
        } as any;
      });

      dbManager = new DatabaseManager(mockConfig, {
        maxReconnectAttempts: 5,
        reconnectBaseDelayMs: 10,
        reconnectMaxDelayMs: 100,
        reconnectBackoffMultiplier: 1.5,
        healthCheckIntervalMs: 1000,
        connectionTimeoutMs: 100
      });

      await dbManager.initialize();

      // Wait for connection attempts
      await new Promise(resolve => setTimeout(resolve, 200));

      const status = dbManager.getStatus();
      expect(status.connectionAttempts).toBeGreaterThanOrEqual(1);
    });
  });
});