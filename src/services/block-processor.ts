import type { Block, Transaction, ProcessingResult, ValidationResult } from '../types/blockchain.js';
import { DatabaseConnection, DatabaseTransaction } from '../database/connection.js';
import { DatabaseManager } from './database-manager.js';
import { UTXORepository } from '../database/repositories/utxo-repository.js';
import { BalanceRepository } from '../database/repositories/balance-repository.js';
import { concurrencyManager } from './concurrency-manager.js';
import { errorHandler } from './error-handler.js';
import {
    validateBlockHeight,
    validateBlockId,
    validateTransactionBalances
} from '../validation/block-validation.js';

export class BlockProcessor {
    private dbManager: DatabaseManager;
    private utxoRepository: UTXORepository;
    private balanceRepository: BalanceRepository;

    constructor(dbManager: DatabaseManager) {
        this.dbManager = dbManager;
        this.utxoRepository = new UTXORepository(dbManager);
        this.balanceRepository = new BalanceRepository(dbManager);
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
     * Process a block atomically with full validation
     * Uses concurrency manager to ensure sequential processing
     * @param block The block to process
     * @returns ProcessingResult indicating success or failure
     */
    async processBlock(block: Block): Promise<ProcessingResult> {
        // Queue the block processing operation to ensure sequential execution
        return concurrencyManager.queueBlockOperation(async () => {
            return this.processBlockInternal(block);
        });
    }

    /**
     * Internal block processing logic (called by concurrency manager)
     * @param block The block to process
     * @returns ProcessingResult indicating success or failure
     */
    private async processBlockInternal(block: Block): Promise<ProcessingResult> {
        return errorHandler.executeWithRetry(
            async () => {
                // Get database connection with retry
                const db = await this.getDbWithRetry();
                
                // Start database transaction for atomic processing
                const transaction = await DatabaseTransaction.begin(db);

                try {
                    // Step 1: Validate the block
                    const validationResult = await this.validateBlock(block, transaction);
                    if (!validationResult.isValid) {
                        await transaction.rollback();
                        return {
                            success: false,
                            blockHeight: block.height,
                            error: `Block validation failed: ${validationResult.errors.join(', ')}`
                        };
                    }

                    // Step 2: Save block to database
                    await this.saveBlock(block, transaction);

                    // Step 3: Process all transactions in the block
                    await this.processTransactions(block.transactions, block.height, transaction);

                    // Step 4: Commit the transaction
                    await transaction.commit();

                    return {
                        success: true,
                        blockHeight: block.height,
                        message: `Block ${block.height} processed successfully`
                    };

                } catch (error) {
                    // Handle database errors with automatic rollback
                    const structuredError = await errorHandler.handleDatabaseError(
                        error instanceof Error ? error : new Error(String(error)),
                        transaction,
                        {
                            operation: 'block_processing',
                            blockHeight: block.height,
                            additionalData: { blockId: block.id, transactionCount: block.transactions.length }
                        }
                    );
                    throw structuredError;
                }
            },
            {
                operation: 'process_block',
                blockHeight: block.height,
                additionalData: { blockId: block.id }
            },
            {
                maxRetries: 2, // Retry database errors up to 2 times
                retryDelayMs: 500,
                shouldRetry: (error, attempt) => {
                    // Only retry database errors, not validation errors
                    return error.retryable && attempt < 2;
                }
            }
        ).catch((error) => {
            // Convert structured error back to ProcessingResult
            const structuredError = (error as any).structuredError;
            if (structuredError) {
                return {
                    success: false,
                    blockHeight: block.height,
                    error: structuredError.message
                };
            }

            return {
                success: false,
                blockHeight: block.height,
                error: `Block processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        });
    }

    /**
     * Validate a block using all validation functions
     * @param block The block to validate
     * @param tx Database transaction for UTXO lookups
     * @returns ValidationResult with validation status and errors
     */
    async validateBlock(block: Block, tx: DatabaseTransaction): Promise<ValidationResult> {
        const errors: string[] = [];

        try {
            // Check if block already exists (duplicate detection)
            const existingBlock = await this.getBlockByHeightOrId(block.height, block.id, tx);
            if (existingBlock) {
                errors.push(`Block at height ${block.height} already processed`);
                return {
                    isValid: false,
                    errors
                };
            }

            // Validate block height is sequential
            const currentHeight = await this.getCurrentHeight(tx);
            if (!validateBlockHeight(block.height, currentHeight)) {
                if (currentHeight === 0) {
                    errors.push(`First block must have height 1, got ${block.height}`);
                } else {
                    errors.push(`Block height must be ${currentHeight + 1}, got ${block.height}`);
                }
            }

            // Validate block ID matches expected hash
            if (!validateBlockId(block)) {
                errors.push('Block ID does not match expected SHA256 hash');
            }

            // Validate transaction balances
            const getUTXOValue = async (txId: string, index: number): Promise<number | null> => {
                const utxo = await this.utxoRepository.getUTXO(txId, index);
                return utxo ? utxo.value : null;
            };

            const transactionBalancesValid = await validateTransactionBalances(
                block.transactions,
                getUTXOValue
            );

            if (!transactionBalancesValid) {
                errors.push('One or more transactions have invalid input/output balance');
            }

            // Additional validation: Check for duplicate transaction IDs within block
            const txIds = block.transactions.map(tx => tx.id);
            const uniqueTxIds = new Set(txIds);
            if (txIds.length !== uniqueTxIds.size) {
                errors.push('Block contains duplicate transaction IDs');
            }

            // Validate transaction structure
            for (let i = 0; i < block.transactions.length; i++) {
                const tx = block.transactions[i];

                // Validate transaction has valid structure
                if (!tx.id || typeof tx.id !== 'string') {
                    errors.push(`Transaction ${i} has invalid ID`);
                }

                if (!Array.isArray(tx.inputs)) {
                    errors.push(`Transaction ${i} has invalid inputs array`);
                }

                if (!Array.isArray(tx.outputs)) {
                    errors.push(`Transaction ${i} has invalid outputs array`);
                }

                // Validate outputs have positive values and valid addresses
                for (let j = 0; j < tx.outputs.length; j++) {
                    const output = tx.outputs[j];
                    if (typeof output.value !== 'number' || output.value < 0) {
                        errors.push(`Transaction ${i} output ${j} has invalid value: ${output.value}`);
                    }
                    if (!output.address || typeof output.address !== 'string') {
                        errors.push(`Transaction ${i} output ${j} has invalid address`);
                    }
                }

                // Validate inputs have valid structure
                for (let j = 0; j < tx.inputs.length; j++) {
                    const input = tx.inputs[j];
                    if (!input.txId || typeof input.txId !== 'string') {
                        errors.push(`Transaction ${i} input ${j} has invalid txId`);
                    }
                    if (typeof input.index !== 'number' || input.index < 0) {
                        errors.push(`Transaction ${i} input ${j} has invalid index: ${input.index}`);
                    }
                }
            }

        } catch (error) {
            errors.push(`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Process all transactions in a block
     * @param transactions Array of transactions to process
     * @param blockHeight Height of the block containing these transactions
     * @param tx Database transaction for atomic operations
     */
    private async processTransactions(
        transactions: Transaction[],
        blockHeight: number,
        tx: DatabaseTransaction
    ): Promise<void> {
        // Track balance changes for batch update
        const balanceChanges = new Map<string, number>();

        for (let i = 0; i < transactions.length; i++) {
            const transaction = transactions[i];

            // Save transaction to database
            await this.saveTransaction(transaction, blockHeight, i, tx);

            // Process inputs (spend UTXOs)
            if (transaction.inputs.length > 0) {
                // First, get UTXO information before marking as spent
                for (const input of transaction.inputs) {
                    const utxo = await this.utxoRepository.getUTXO(input.txId, input.index);
                    if (utxo) {
                        const currentChange = balanceChanges.get(utxo.address) || 0;
                        balanceChanges.set(utxo.address, currentChange - utxo.value);
                    }
                }

                // Then mark UTXOs as spent
                await this.utxoRepository.spendUTXOs(
                    transaction.inputs,
                    transaction.id,
                    blockHeight,
                    tx
                );
            }

            // Process outputs (create new UTXOs)
            await this.utxoRepository.saveUTXOs(
                transaction.outputs,
                transaction.id,
                blockHeight,
                tx
            );

            // Add output values to recipient balances
            for (const output of transaction.outputs) {
                const currentChange = balanceChanges.get(output.address) || 0;
                balanceChanges.set(output.address, currentChange + output.value);
            }
        }

        // Apply all balance changes in batch
        await this.applyBalanceChanges(balanceChanges, blockHeight, tx);
    }

    /**
     * Apply balance changes to affected addresses
     * @param balanceChanges Map of address to balance change amount
     * @param blockHeight Block height for the balance update
     * @param tx Database transaction for atomic operations
     */
    private async applyBalanceChanges(
        balanceChanges: Map<string, number>,
        blockHeight: number,
        tx: DatabaseTransaction
    ): Promise<void> {
        for (const [address, change] of balanceChanges) {
            if (change !== 0) {
                const currentBalance = await this.balanceRepository.getBalance(address, tx);
                const newBalance = currentBalance + change;

                if (newBalance < 0) {
                    throw new Error(`Balance would become negative for address ${address}: ${newBalance}`);
                }

                await this.balanceRepository.updateBalance(address, newBalance, blockHeight, tx);
            }
        }
    }

    /**
     * Save block metadata to database
     * @param block Block to save
     * @param tx Database transaction for atomic operations
     */
    private async saveBlock(block: Block, tx: DatabaseTransaction): Promise<void> {
        const query = `
      INSERT INTO blocks (height, id, transaction_count, created_at)
      VALUES ($1, $2, $3, NOW())
    `;

        await tx.query(query, [
            block.height,
            block.id,
            block.transactions.length
        ]);
    }

    /**
     * Save transaction to database
     * @param transaction Transaction to save
     * @param blockHeight Height of containing block
     * @param transactionIndex Index of transaction within block
     * @param tx Database transaction for atomic operations
     */
    private async saveTransaction(
        transaction: Transaction,
        blockHeight: number,
        transactionIndex: number,
        tx: DatabaseTransaction
    ): Promise<void> {
        // Save transaction
        const txQuery = `
      INSERT INTO transactions (id, block_height, transaction_index)
      VALUES ($1, $2, $3)
    `;

        await tx.query(txQuery, [
            transaction.id,
            blockHeight,
            transactionIndex
        ]);

        // Save transaction inputs
        for (let i = 0; i < transaction.inputs.length; i++) {
            const input = transaction.inputs[i];
            const inputQuery = `
        INSERT INTO transaction_inputs (transaction_id, utxo_tx_id, utxo_index, input_index)
        VALUES ($1, $2, $3, $4)
      `;

            await tx.query(inputQuery, [
                transaction.id,
                input.txId,
                input.index,
                i
            ]);
        }
    }

    /**
     * Rollback blockchain state to a specific height
     * Uses concurrency manager to ensure exclusive access during rollback
     * @param targetHeight The height to rollback to
     * @returns ProcessingResult indicating success or failure
     */
    async rollbackToHeight(targetHeight: number): Promise<ProcessingResult> {
        // Execute rollback with exclusive access (blocks new block processing)
        return concurrencyManager.executeRollback(async () => {
            return this.rollbackToHeightInternal(targetHeight);
        });
    }

    /**
     * Internal rollback logic (called by concurrency manager)
     * @param targetHeight The height to rollback to
     * @returns ProcessingResult indicating success or failure
     */
    private async rollbackToHeightInternal(targetHeight: number): Promise<ProcessingResult> {
        return errorHandler.executeWithRetry(
            async () => {
                // Get database connection with retry
                const db = await this.getDbWithRetry();
                
                // Start database transaction for atomic rollback
                const transaction = await DatabaseTransaction.begin(db);
                let currentHeight = 0;

                try {
                    // Step 1: Validate rollback target
                    currentHeight = await this.getCurrentHeight(transaction);

                    if (targetHeight < 0) {
                        await transaction.rollback();
                        return {
                            success: false,
                            blockHeight: targetHeight,
                            error: 'Target height cannot be negative'
                        };
                    }

                    if (targetHeight > currentHeight) {
                        await transaction.rollback();
                        return {
                            success: false,
                            blockHeight: targetHeight,
                            error: `Target height ${targetHeight} is greater than current height ${currentHeight}`
                        };
                    }

                    // Validate rollback is within 2000 blocks limit
                    if (currentHeight - targetHeight > 2000) {
                        await transaction.rollback();
                        return {
                            success: false,
                            blockHeight: targetHeight,
                            error: `Rollback limited to 2000 blocks. Current: ${currentHeight}, Target: ${targetHeight}, Difference: ${currentHeight - targetHeight}`
                        };
                    }

                    // Step 2: Remove blocks after target height
                    await this.removeBlocksAfterHeight(targetHeight, transaction);

                    // Step 3: Rollback UTXOs (unspend and remove outputs created after target height)
                    await this.utxoRepository.rollbackUTXOsAfterHeight(targetHeight, transaction);

                    // Step 4: Recalculate all balances from current UTXO state
                    await this.balanceRepository.recalculateAllBalances(transaction);

                    // Step 5: Commit the transaction
                    await transaction.commit();

                    return {
                        success: true,
                        blockHeight: targetHeight,
                        message: `Successfully rolled back to height ${targetHeight}`
                    };

                } catch (error) {
                    // Handle database errors with automatic rollback
                    const structuredError = await errorHandler.handleDatabaseError(
                        error instanceof Error ? error : new Error(String(error)),
                        transaction,
                        {
                            operation: 'rollback_to_height',
                            blockHeight: targetHeight,
                            additionalData: { currentHeight }
                        }
                    );
                    throw structuredError;
                }
            },
            {
                operation: 'rollback_to_height',
                blockHeight: targetHeight
            },
            {
                maxRetries: 1, // Rollback operations are more critical, fewer retries
                retryDelayMs: 1000,
                shouldRetry: (error, attempt) => {
                    // Only retry database connection errors for rollbacks
                    return error.retryable && error.message.includes('connection') && attempt < 1;
                }
            }
        ).catch((error) => {
            // Convert structured error back to ProcessingResult
            const structuredError = (error as any).structuredError;
            if (structuredError) {
                return {
                    success: false,
                    blockHeight: targetHeight,
                    error: structuredError.message
                };
            }

            return {
                success: false,
                blockHeight: targetHeight,
                error: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        });
    }

    /**
     * Remove all blocks and their transactions after the target height
     * @param targetHeight The height to rollback to
     * @param tx Database transaction for atomic operations
     */
    private async removeBlocksAfterHeight(targetHeight: number, tx: DatabaseTransaction): Promise<void> {
        // Remove transaction inputs for transactions in blocks after target height
        const removeInputsQuery = `
      DELETE FROM transaction_inputs 
      WHERE transaction_id IN (
        SELECT t.id 
        FROM transactions t 
        WHERE t.block_height > $1
      )
    `;
        await tx.query(removeInputsQuery, [targetHeight]);

        // Remove transactions in blocks after target height
        // (transaction_outputs will be handled by UTXORepository.rollbackUTXOsAfterHeight)
        const removeTransactionsQuery = `
      DELETE FROM transactions 
      WHERE block_height > $1
    `;
        await tx.query(removeTransactionsQuery, [targetHeight]);

        // Remove blocks after target height
        const removeBlocksQuery = `
      DELETE FROM blocks 
      WHERE height > $1
    `;
        await tx.query(removeBlocksQuery, [targetHeight]);
    }

    /**
     * Get current highest block height
     * @param tx Optional database transaction
     * @returns Current block height or 0 if no blocks exist
     */
    private async getCurrentHeight(tx?: DatabaseTransaction): Promise<number> {
        const query = `
      SELECT COALESCE(MAX(height), 0) as max_height 
      FROM blocks
    `;

        const result = tx ? 
            await tx.query(query) : 
            await (await this.getDb()).query(query);
        
        return result.rows[0].max_height;
    }

    /**
     * Check if a block already exists by height or ID
     * @param height Block height to check
     * @param id Block ID to check
     * @param tx Database transaction
     * @returns Block data if exists, null otherwise
     */
    private async getBlockByHeightOrId(height: number, id: string, tx: DatabaseTransaction): Promise<any> {
        const query = `
      SELECT height, id 
      FROM blocks 
      WHERE height = $1 OR id = $2
      LIMIT 1
    `;

        const result = await tx.query(query, [height, id]);
        return result.rows.length > 0 ? result.rows[0] : null;
    }
}