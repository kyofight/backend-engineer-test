import { DatabaseConnection, DatabaseTransaction } from '@database/connection.js';
import { DatabaseManager } from '@services/database-manager.js';
import type { Balance, BalanceEntity, BalanceUpdate } from '@shared/blockchain.js';

export class BalanceRepository {
    private dbManager: DatabaseManager;

    constructor(dbManager: DatabaseManager) {
        this.dbManager = dbManager;
    }

    // Get database connection, throw error if not available
    private async getDb(): Promise<DatabaseConnection> {
        const db = this.dbManager.getConnection();
        if (!db) {
            throw new Error('Database connection not available. Please try again later.');
        }
        return db;
    }

    // Get database connection with retry
    private async getDbWithRetry(): Promise<DatabaseConnection> {
        return await this.dbManager.getConnectionWithRetry();
    }

    /**
     * Get the current balance for a specific address
     * @param address The blockchain address to query
     * @param tx Optional database transaction for reading within transaction context
     * @returns The current balance, or 0 if address has no balance record
     */
    async getBalance(address: string, tx?: DatabaseTransaction): Promise<number> {
        const query = `
            SELECT balance 
            FROM balances 
            WHERE address = $1
        `;

        const result = tx ? 
            await tx.query(query, [address]) : 
            await (await this.getDb()).query(query, [address]);

        if (result.rows.length === 0) {
            return 0;
        }

        return parseFloat(result.rows[0].balance);
    }

    /**
     * Update the balance for a specific address
     * @param address The blockchain address to update
     * @param amount The new balance amount
     * @param blockHeight The block height at which this balance was updated
     * @param tx Optional database transaction for atomic operations
     */
    async updateBalance(
        address: string,
        amount: number,
        blockHeight: number,
        tx?: DatabaseTransaction
    ): Promise<void> {
        const query = `
            INSERT INTO balances (address, balance, last_updated_height, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (address) 
            DO UPDATE SET 
                balance = EXCLUDED.balance,
                last_updated_height = EXCLUDED.last_updated_height,
                updated_at = EXCLUDED.updated_at
        `;

        if (tx) {
            await tx.query(query, [
                address,
                amount.toString(), // Convert to string for DECIMAL storage
                blockHeight
            ]);
        } else {
            const db = await this.getDbWithRetry();
            await db.query(query, [
                address,
                amount.toString(), // Convert to string for DECIMAL storage
                blockHeight
            ]);
        }
    }

    /**
     * Batch update multiple address balances in a single transaction
     * @param updates Array of balance updates to apply
     * @param blockHeight The block height at which these balances were updated
     * @param tx Optional database transaction for atomic operations
     */
    async batchUpdateBalances(
        updates: BalanceUpdate[],
        blockHeight: number,
        tx?: DatabaseTransaction
    ): Promise<void> {
        if (updates.length === 0) {
            return;
        }

        // Build parameterized query for batch insert/update
        const values: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        for (const update of updates) {
            values.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, NOW())`);
            params.push(update.address, update.amount.toString(), blockHeight);
            paramIndex += 3;
        }

        const query = `
            INSERT INTO balances (address, balance, last_updated_height, updated_at)
            VALUES ${values.join(', ')}
            ON CONFLICT (address) 
            DO UPDATE SET 
                balance = EXCLUDED.balance,
                last_updated_height = EXCLUDED.last_updated_height,
                updated_at = EXCLUDED.updated_at
        `;

        if (tx) {
            await tx.query(query, params);
        } else {
            const db = await this.getDbWithRetry();
            await db.query(query, params);
        }
    }

    /**
     * Get all balances with their metadata
     * @returns Array of all balance records
     */
    async getAllBalances(): Promise<Balance[]> {
        const query = `
            SELECT address, balance, last_updated_height
            FROM balances 
            ORDER BY address
        `;

        const db = await this.getDb();
        const result = await db.query(query);

        return result.rows.map((row: BalanceEntity) => ({
            address: row.address,
            balance: parseFloat(row.balance),
            lastUpdatedHeight: row.last_updated_height
        }));
    }

    /**
     * Get balances for multiple addresses
     * @param addresses Array of addresses to query
     * @returns Array of balance records for the specified addresses
     */
    async getBalancesForAddresses(addresses: string[]): Promise<Balance[]> {
        if (addresses.length === 0) {
            return [];
        }

        const placeholders = addresses.map((_, index) => `$${index + 1}`).join(', ');
        const query = `
            SELECT address, balance, last_updated_height
            FROM balances 
            WHERE address IN (${placeholders})
            ORDER BY address
        `;

        const db = await this.getDb();
        const result = await db.query(query, addresses);

        return result.rows.map((row: BalanceEntity) => ({
            address: row.address,
            balance: parseFloat(row.balance),
            lastUpdatedHeight: row.last_updated_height
        }));
    }

    /**
     * Reset all balances to zero (used during rollback operations)
     * @param tx Optional database transaction for atomic operations
     */
    async resetAllBalances(tx?: DatabaseTransaction): Promise<void> {
        const query = `
            UPDATE balances 
            SET balance = 0, 
                last_updated_height = 0, 
                updated_at = NOW()
        `;

        if (tx) {
            await tx.query(query);
        } else {
            const db = await this.getDbWithRetry();
            await db.query(query);
        }
    }

    /**
     * Delete balance records for addresses with zero balance
     * This is useful for cleanup after rollbacks
     * @param tx Optional database transaction for atomic operations
     */
    async cleanupZeroBalances(tx?: DatabaseTransaction): Promise<void> {
        const query = `
            DELETE FROM balances 
            WHERE balance = 0
        `;

        if (tx) {
            await tx.query(query);
        } else {
            const db = await this.getDbWithRetry();
            await db.query(query);
        }
    }

    /**
     * Recalculate all address balances from current UTXO state
     * This sums all unspent UTXOs for each address to get accurate balances
     * Used after rollback operations to ensure balance accuracy
     * @param tx Optional database transaction for atomic operations
     */
    async recalculateAllBalances(tx?: DatabaseTransaction): Promise<void> {
        // First, reset all balances to 0
        const resetQuery = `
            UPDATE balances 
            SET balance = 0, 
                last_updated_height = 0, 
                updated_at = NOW()
        `;

        if (tx) {
            await tx.query(resetQuery);
        } else {
            const db = await this.getDbWithRetry();
            await db.query(resetQuery);
        }

        // Calculate new balances from unspent UTXOs and insert/update
        const recalculateQuery = `
            INSERT INTO balances (address, balance, last_updated_height, updated_at)
            SELECT 
                address,
                SUM(CAST(value AS DECIMAL(20,8))) as balance,
                0 as last_updated_height,
                NOW() as updated_at
            FROM transaction_outputs 
            WHERE is_spent = false
            GROUP BY address
            HAVING SUM(CAST(value AS DECIMAL(20,8))) > 0
            ON CONFLICT (address) 
            DO UPDATE SET 
                balance = EXCLUDED.balance,
                last_updated_height = EXCLUDED.last_updated_height,
                updated_at = EXCLUDED.updated_at
        `;

        if (tx) {
            await tx.query(recalculateQuery);
        } else {
            const db = await this.getDbWithRetry();
            await db.query(recalculateQuery);
        }

        // Clean up any remaining zero balances
        await this.cleanupZeroBalances(tx);
    }

    /**
     * Recalculate balance for a specific address from its unspent UTXOs
     * @param address The address to recalculate balance for
     * @param blockHeight The block height to set as last updated height
     * @param tx Optional database transaction for atomic operations
     */
    async recalculateBalanceForAddress(
        address: string,
        blockHeight: number,
        tx?: DatabaseTransaction
    ): Promise<void> {
        // Calculate balance from unspent UTXOs for this address
        const calculateQuery = `
            SELECT COALESCE(SUM(CAST(value AS DECIMAL(20,8))), 0) as balance
            FROM transaction_outputs 
            WHERE address = $1 AND is_spent = false
        `;

        const result = tx ? 
            await tx.query(calculateQuery, [address]) :
            await (await this.getDbWithRetry()).query(calculateQuery, [address]);
        
        const balance = parseFloat(result.rows[0].balance);

        // Update or insert the balance
        if (balance > 0) {
            await this.updateBalance(address, balance, blockHeight, tx);
        } else {
            // If balance is 0, we can either update to 0 or delete the record
            const deleteQuery = `
                DELETE FROM balances WHERE address = $1
            `;
            if (tx) {
                await tx.query(deleteQuery, [address]);
            } else {
                const db = await this.getDbWithRetry();
                await db.query(deleteQuery, [address]);
            }
        }
    }

    /**
     * Get the current highest block height from the blocks table
     * This is used to set appropriate last_updated_height values
     * @returns The highest block height, or 0 if no blocks exist
     */
    async getCurrentHeight(): Promise<number> {
        const query = `
            SELECT COALESCE(MAX(height), 0) as max_height 
            FROM blocks
        `;

        const db = await this.getDb();
        const result = await db.query(query);
        return result.rows[0].max_height;
    }
}