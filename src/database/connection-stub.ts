// Temporary stub for development when pg types aren't available

export interface PoolConfig {
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    ssl?: boolean | any;
}

export interface PoolClient {
    query(text: string, params?: any[]): Promise<any>;
    release(): void;
}

export interface Pool {
    connect(): Promise<PoolClient>;
    query(text: string, params?: any[]): Promise<any>;
    end(): Promise<void>;
    on(event: string, listener: (err: Error) => void): void;
}

export class DatabaseConnection {
    private pool: Pool;
    private static instance: DatabaseConnection;

    private constructor(config: PoolConfig) {
        // This is a stub - replace with actual pg.Pool when dependencies are installed
        this.pool = {
            connect: async () => ({
                query: async (text: string, params?: any[]) => this.handleQuery(text, params),
                release: () => {}
            } as PoolClient),
            query: async (text: string, params?: any[]) => this.handleQuery(text, params),
            end: async () => {},
            on: () => {}
        } as Pool;
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
        return DatabaseConnection.getInstance({
            connectionString: databaseUrl,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });
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

    public async runMigrations(): Promise<void> {
        console.log('Migration method available - implement when runtime is configured');
    }

    // In-memory storage for testing
    private static storage = {
        blocks: new Map<number, any>(),
        transactions: new Map<string, any>(),
        transaction_outputs: new Map<string, any>(),
        balances: new Map<string, any>(),
        transaction_inputs: new Map<string, any>()
    };

    public static clearStorage(): void {
        DatabaseConnection.storage.blocks.clear();
        DatabaseConnection.storage.transactions.clear();
        DatabaseConnection.storage.transaction_outputs.clear();
        DatabaseConnection.storage.balances.clear();
        DatabaseConnection.storage.transaction_inputs.clear();
    }

    private handleQuery(text: string, params?: any[]): Promise<any> {
        const sql = text.trim().toLowerCase();
        const storage = DatabaseConnection.storage;
        
        // Handle getCurrentHeight queries
        if (sql.includes('select') && sql.includes('max(height)') && sql.includes('from blocks')) {
            const maxHeight = storage.blocks.size > 0 ? Math.max(...storage.blocks.keys()) : 0;
            return Promise.resolve({ rows: [{ max_height: maxHeight }] });
        }
        
        // Handle block existence check
        if (sql.includes('select') && sql.includes('from blocks') && sql.includes('where')) {
            const height = params?.[0];
            const id = params?.[1];
            
            for (const [blockHeight, block] of storage.blocks) {
                if (blockHeight === height || block.id === id) {
                    return Promise.resolve({ rows: [{ height: blockHeight, id: block.id }] });
                }
            }
            return Promise.resolve({ rows: [] });
        }
        
        // Handle block inserts
        if (sql.includes('insert into blocks')) {
            const [height, id, transactionCount] = params || [];
            storage.blocks.set(height, { id, transaction_count: transactionCount });
            return Promise.resolve({ rows: [] });
        }
        
        // Handle transaction inserts
        if (sql.includes('insert into transactions')) {
            const [id, blockHeight, transactionIndex] = params || [];
            storage.transactions.set(id, { block_height: blockHeight, transaction_index: transactionIndex });
            return Promise.resolve({ rows: [] });
        }
        
        // Handle transaction output inserts
        if (sql.includes('insert into transaction_outputs')) {
            const [txId, outputIndex, address, value, isSpent, spentByTxId, spentAtHeight] = params || [];
            const key = `${txId}:${outputIndex}`;
            storage.transaction_outputs.set(key, {
                transaction_id: txId,
                output_index: outputIndex,
                address,
                value: parseFloat(value),
                is_spent: isSpent || false,
                spent_by_tx_id: spentByTxId,
                spent_at_height: spentAtHeight
            });
            return Promise.resolve({ rows: [] });
        }
        
        // Handle UTXO spending (UPDATE transaction_outputs SET is_spent = true)
        if (sql.includes('update transaction_outputs') && sql.includes('is_spent = true')) {
            // This should be a parameterized query for spending specific UTXOs
            // For now, we'll handle it in a simplified way
            // The actual implementation would need to parse the WHERE clause
            return Promise.resolve({ rows: [] });
        }
        
        // Handle UTXO queries
        if (sql.includes('select') && sql.includes('from transaction_outputs') && sql.includes('where')) {
            const txId = params?.[0];
            const index = params?.[1];
            const key = `${txId}:${index}`;
            const utxo = storage.transaction_outputs.get(key);
            
            if (utxo) {
                return Promise.resolve({ 
                    rows: [{
                        tx_id: utxo.transaction_id,
                        index: utxo.output_index,
                        address: utxo.address,
                        value: utxo.value.toString(),
                        is_spent: utxo.is_spent,
                        spent_by_tx_id: utxo.spent_by_tx_id,
                        spent_at_height: utxo.spent_at_height
                    }]
                });
            }
            return Promise.resolve({ rows: [] });
        }
        
        // Handle balance queries
        if (sql.includes('select') && sql.includes('from balances') && sql.includes('where')) {
            const address = params?.[0];
            const balance = storage.balances.get(address);
            
            if (balance) {
                return Promise.resolve({ 
                    rows: [{ balance: balance.balance.toString() }]
                });
            }
            return Promise.resolve({ rows: [] });
        }
        
        // Handle balance inserts/updates (ON CONFLICT DO UPDATE)
        if (sql.includes('insert into balances') && sql.includes('on conflict')) {
            const [address, balance, blockHeight] = params || [];
            storage.balances.set(address, {
                address,
                balance: parseFloat(balance),
                last_updated_height: blockHeight,
                updated_at: new Date()
            });
            return Promise.resolve({ rows: [] });
        }
        
        // Handle balance recalculation queries
        if (sql.includes('select') && sql.includes('transaction_outputs') && sql.includes('group by address')) {
            // This is the balance recalculation query
            // Calculate balances from unspent UTXOs
            const balanceMap = new Map<string, number>();
            
            for (const [key, utxo] of storage.transaction_outputs) {
                if (!utxo.is_spent) {
                    const currentBalance = balanceMap.get(utxo.address) || 0;
                    balanceMap.set(utxo.address, currentBalance + utxo.value);
                }
            }
            
            const rows = Array.from(balanceMap.entries()).map(([address, balance]) => ({
                address,
                balance: balance.toString()
            }));
            
            return Promise.resolve({ rows });
        }
        
        // Handle DELETE from balances (for recalculation)
        if (sql.includes('delete from balances')) {
            storage.balances.clear();
            return Promise.resolve({ rows: [] });
        }
        
        // Handle transaction input inserts
        if (sql.includes('insert into transaction_inputs')) {
            const [transactionId, utxoTxId, utxoIndex, inputIndex] = params || [];
            const key = `${transactionId}:${inputIndex}`;
            storage.transaction_inputs.set(key, {
                transaction_id: transactionId,
                utxo_tx_id: utxoTxId,
                utxo_index: utxoIndex,
                input_index: inputIndex
            });
            return Promise.resolve({ rows: [] });
        }
        
        // Handle UPDATE operations for rollback (unspend UTXOs)
        if (sql.includes('update transaction_outputs') && sql.includes('is_spent = false')) {
            // Unspend UTXOs that were spent in blocks after target height
            const targetHeight = params?.[0];
            if (typeof targetHeight === 'number') {
                for (const [key, utxo] of storage.transaction_outputs) {
                    if (utxo.spent_at_height && utxo.spent_at_height > targetHeight) {
                        utxo.is_spent = false;
                        utxo.spent_by_tx_id = null;
                        utxo.spent_at_height = null;
                    }
                }
            }
            return Promise.resolve({ rows: [] });
        }
        
        // Handle DELETE operations for rollback
        if (sql.includes('delete from transaction_inputs')) {
            // Remove transaction inputs for transactions in blocks after target height
            const targetHeight = params?.[0];
            if (typeof targetHeight === 'number') {
                // Remove transaction inputs from transactions in blocks after target height
                const txsToRemove = [];
                for (const [txId, tx] of storage.transactions) {
                    if (tx.block_height > targetHeight) {
                        txsToRemove.push(txId);
                    }
                }
                
                for (const [key, input] of storage.transaction_inputs) {
                    if (txsToRemove.includes(input.transaction_id)) {
                        storage.transaction_inputs.delete(key);
                    }
                }
            }
            return Promise.resolve({ rows: [] });
        }
        
        if (sql.includes('delete from transactions')) {
            // Remove transactions in blocks after target height
            if (sql.includes('block_height >')) {
                const targetHeight = params?.[0];
                if (typeof targetHeight === 'number') {
                    // Remove transactions from blocks after target height
                    for (const [txId, tx] of storage.transactions) {
                        if (tx.block_height > targetHeight) {
                            storage.transactions.delete(txId);
                        }
                    }
                }
            }
            return Promise.resolve({ rows: [] });
        }
        
        if (sql.includes('delete from transaction_outputs')) {
            // Remove UTXOs created in blocks after target height
            const targetHeight = params?.[0];
            if (typeof targetHeight === 'number') {
                // Find transactions in blocks after target height
                const txsToRemove = [];
                for (const [txId, tx] of storage.transactions) {
                    if (tx.block_height > targetHeight) {
                        txsToRemove.push(txId);
                    }
                }
                
                // Remove UTXOs from those transactions
                for (const [key, utxo] of storage.transaction_outputs) {
                    if (txsToRemove.includes(utxo.transaction_id)) {
                        storage.transaction_outputs.delete(key);
                    }
                }
            }
            return Promise.resolve({ rows: [] });
        }
        
        if (sql.includes('delete from blocks')) {
            // Remove blocks after target height
            if (sql.includes('height >')) {
                const targetHeight = params?.[0];
                if (typeof targetHeight === 'number') {
                    // Remove blocks after target height
                    for (const [height] of storage.blocks) {
                        if (height > targetHeight) {
                            storage.blocks.delete(height);
                        }
                    }
                }
            }
            return Promise.resolve({ rows: [] });
        }
        
        // Default response for other queries
        return Promise.resolve({ rows: [] });
    }
}

export class DatabaseTransaction {
    private db: DatabaseConnection;
    private isCommitted = false;
    private isRolledBack = false;

    constructor(db: DatabaseConnection) {
        this.db = db;
    }

    public static async begin(db: DatabaseConnection): Promise<DatabaseTransaction> {
        return new DatabaseTransaction(db);
    }

    public async query(text: string, params?: any[]): Promise<any> {
        if (this.isCommitted || this.isRolledBack) {
            throw new Error('Transaction has already been committed or rolled back');
        }
        
        // For the stub, just delegate to the main connection
        return await this.db.query(text, params);
    }

    public async commit(): Promise<void> {
        if (this.isCommitted || this.isRolledBack) {
            throw new Error('Transaction has already been committed or rolled back');
        }
        
        this.isCommitted = true;
        // In a real implementation, this would commit the transaction
        // For the stub, we don't need to do anything special
    }

    public async rollback(): Promise<void> {
        if (this.isCommitted || this.isRolledBack) {
            throw new Error('Transaction has already been committed or rolled back');
        }
        
        this.isRolledBack = true;
        // In a real implementation, this would rollback the transaction
        // For the stub, we don't need to do anything special
    }
}