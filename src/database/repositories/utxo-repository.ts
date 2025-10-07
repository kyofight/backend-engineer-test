import { DatabaseConnection, DatabaseTransaction } from '@database/connection.js';
import { DatabaseManager } from '@services/database-manager.js';
import type { UTXO, Input, Output } from '@shared/blockchain.js';

export class UTXORepository {
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
     * Save new UTXOs (transaction outputs) to the database
     * @param outputs Array of outputs to save as UTXOs
     * @param txId Transaction ID that created these outputs
     * @param blockHeight Block height where transaction was included
     * @param tx Optional database transaction for atomic operations
     */
    async saveUTXOs(
        outputs: Output[], 
        txId: string, 
        blockHeight: number, 
        tx?: DatabaseTransaction
    ): Promise<void> {
        const query = `
            INSERT INTO transaction_outputs (
                transaction_id, 
                output_index, 
                address, 
                value, 
                is_spent, 
                spent_by_tx_id, 
                spent_at_height
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;

        for (let i = 0; i < outputs.length; i++) {
            const output = outputs[i];
            if (tx) {
                await tx.query(query, [
                    txId,
                    i, // output_index
                    output.address,
                    output.value.toString(), // Convert to string for DECIMAL storage
                    false, // is_spent - new UTXOs are unspent
                    null, // spent_by_tx_id
                    null  // spent_at_height
                ]);
            } else {
                const db = await this.getDbWithRetry();
                await db.query(query, [
                    txId,
                    i, // output_index
                    output.address,
                    output.value.toString(), // Convert to string for DECIMAL storage
                    false, // is_spent - new UTXOs are unspent
                    null, // spent_by_tx_id
                    null  // spent_at_height
                ]);
            }
        }
    }

    /**
     * Mark UTXOs as spent by updating the database records
     * @param inputs Array of inputs that reference UTXOs to spend
     * @param spentByTxId Transaction ID that is spending these UTXOs
     * @param blockHeight Block height where spending transaction was included
     * @param tx Optional database transaction for atomic operations
     */
    async spendUTXOs(
        inputs: Input[], 
        spentByTxId: string, 
        blockHeight: number, 
        tx?: DatabaseTransaction
    ): Promise<void> {
        const query = `
            UPDATE transaction_outputs 
            SET is_spent = true, 
                spent_by_tx_id = $1, 
                spent_at_height = $2
            WHERE transaction_id = $3 
              AND output_index = $4 
              AND is_spent = false
        `;

        for (const input of inputs) {
            const result = tx ? 
                await tx.query(query, [
                    spentByTxId,
                    blockHeight,
                    input.txId,
                    input.index
                ]) :
                await (await this.getDbWithRetry()).query(query, [
                    spentByTxId,
                    blockHeight,
                    input.txId,
                    input.index
                ]);

            // Verify that exactly one row was updated
            if (result.rowCount === 0) {
                throw new Error(
                    `UTXO not found or already spent: txId=${input.txId}, index=${input.index}`
                );
            }
        }
    }

    /**
     * Retrieve a specific UTXO by transaction ID and output index
     * @param txId Transaction ID that created the UTXO
     * @param index Output index within the transaction
     * @returns UTXO object or null if not found
     */
    async getUTXO(txId: string, index: number): Promise<UTXO | null> {
        const query = `
            SELECT 
                transaction_id as tx_id,
                output_index as index,
                address,
                value,
                is_spent,
                spent_by_tx_id,
                spent_at_height
            FROM transaction_outputs 
            WHERE transaction_id = $1 AND output_index = $2
        `;

        const db = await this.getDb();
        const result = await db.query(query, [txId, index]);
        
        if (result.rows.length === 0) {
            return null;
        }

        const row = result.rows[0];
        return {
            txId: row.tx_id,
            index: row.index,
            address: row.address,
            value: parseFloat(row.value), // Convert from DECIMAL string to number
            isSpent: row.is_spent,
            spentByTxId: row.spent_by_tx_id || undefined,
            spentAtHeight: row.spent_at_height || undefined
        };
    }

    /**
     * Get all unspent UTXOs for a specific address
     * @param address The blockchain address to query
     * @returns Array of unspent UTXOs for the address
     */
    async getUnspentUTXOsForAddress(address: string): Promise<UTXO[]> {
        const query = `
            SELECT 
                transaction_id as tx_id,
                output_index as index,
                address,
                value,
                is_spent,
                spent_by_tx_id,
                spent_at_height
            FROM transaction_outputs 
            WHERE address = $1 AND is_spent = false
            ORDER BY transaction_id, output_index
        `;

        const db = await this.getDb();
        const result = await db.query(query, [address]);
        
        return result.rows.map((row: any) => ({
            txId: row.tx_id,
            index: row.index,
            address: row.address,
            value: parseFloat(row.value),
            isSpent: row.is_spent,
            spentByTxId: row.spent_by_tx_id || undefined,
            spentAtHeight: row.spent_at_height || undefined
        }));
    }

    /**
     * Rollback UTXOs to a specific block height by undoing transactions after that height
     * This involves:
     * 1. Unspending UTXOs that were spent after the target height
     * 2. Removing UTXOs that were created after the target height
     * @param targetHeight The block height to rollback to
     * @param tx Optional database transaction for atomic operations
     */
    async rollbackUTXOsAfterHeight(targetHeight: number, tx?: DatabaseTransaction): Promise<void> {
        // Step 1: Unspend UTXOs that were spent after the target height
        // This restores UTXOs that were spent in blocks after the rollback point
        const unspendQuery = `
            UPDATE transaction_outputs 
            SET is_spent = false, 
                spent_by_tx_id = NULL, 
                spent_at_height = NULL
            WHERE spent_at_height > $1
        `;

        if (tx) {
            await tx.query(unspendQuery, [targetHeight]);
        } else {
            const db = await this.getDbWithRetry();
            await db.query(unspendQuery, [targetHeight]);
        }

        // Step 2: Remove UTXOs that were created after the target height
        // This removes outputs from transactions in blocks after the rollback point
        const deleteQuery = `
            DELETE FROM transaction_outputs 
            WHERE transaction_id IN (
                SELECT t.id 
                FROM transactions t 
                WHERE t.block_height > $1
            )
        `;

        if (tx) {
            await tx.query(deleteQuery, [targetHeight]);
        } else {
            const db = await this.getDbWithRetry();
            await db.query(deleteQuery, [targetHeight]);
        }
    }



    /**
     * Get the current highest block height from the blocks table
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