import type { Pool, PoolClient, PoolConfig } from 'pg';

export class DatabaseConnection {
    private pool: Pool;
    private static instance: DatabaseConnection;

    private constructor(config: PoolConfig) {
        // Dynamic import to handle module loading
        const { Pool } = require('pg');
        this.pool = new Pool(config);

        // Handle pool errors
        this.pool.on('error', (err: Error) => {
            console.error('Unexpected error on idle client', err);
        });
    }

    public static getInstance(config?: PoolConfig): DatabaseConnection {
        if (!DatabaseConnection.instance) {
            if (!config) {
                throw new Error('Database configuration required for first initialization');
            }
            DatabaseConnection.instance = new DatabaseConnection(config);
        }
        return DatabaseConnection.instance;
    }

    public static createFromUrl(databaseUrl: string): DatabaseConnection {
        // Don't use singleton for new connections to avoid pool reuse issues
        const { Pool } = require('pg');
        const config = {
            connectionString: databaseUrl,
            max: 20, // Maximum number of clients in the pool
            idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
            connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
        };

        const connection = new DatabaseConnection(config);
        return connection;
    }

    public getPool(): Pool {
        return this.pool;
    }

    public async getClient(): Promise<PoolClient> {
        return await this.pool.connect();
    }

    public async query(text: string, params?: any[]): Promise<any> {
        return await this.pool.query(text, params);
    }

    public async close(): Promise<void> {
        await this.pool.end();
    }

    // Run migrations
    public async runMigrations(): Promise<void> {
        try {
            // For now, we'll handle migrations manually or through a separate script
            // This method can be implemented when the runtime environment is properly set up
            console.log('Migration method available - implement when runtime is configured');
        } catch (error) {
            console.error('Failed to run migrations:', error);
            throw error;
        }
    }
}

// Database transaction wrapper for atomic operations
export class DatabaseTransaction {
    private client: PoolClient;
    private isCommitted: boolean = false;
    private isRolledBack: boolean = false;

    constructor(client: PoolClient) {
        this.client = client;
    }

    public static async begin(db: DatabaseConnection): Promise<DatabaseTransaction> {
        const client = await db.getClient();
        await client.query('BEGIN');
        return new DatabaseTransaction(client);
    }

    public async query(text: string, params?: any[]): Promise<any> {
        if (this.isCommitted || this.isRolledBack) {
            throw new Error('Cannot execute query on completed transaction');
        }
        return await this.client.query(text, params);
    }

    public async commit(): Promise<void> {
        if (this.isCommitted || this.isRolledBack) {
            throw new Error('Transaction already completed');
        }

        try {
            await this.client.query('COMMIT');
            this.isCommitted = true;
        } finally {
            this.client.release();
        }
    }

    public async rollback(): Promise<void> {
        if (this.isCommitted || this.isRolledBack) {
            throw new Error('Transaction already completed');
        }

        try {
            await this.client.query('ROLLBACK');
            this.isRolledBack = true;
        } finally {
            this.client.release();
        }
    }

    public getClient(): PoolClient {
        return this.client;
    }
}

// Utility function for running operations within a transaction
export async function withTransaction<T>(
    db: DatabaseConnection,
    operation: (tx: DatabaseTransaction) => Promise<T>
): Promise<T> {
    const tx = await DatabaseTransaction.begin(db);

    try {
        const result = await operation(tx);
        await tx.commit();
        return result;
    } catch (error) {
        await tx.rollback();
        throw error;
    }
}