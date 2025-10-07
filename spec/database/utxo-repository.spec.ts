import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { UTXORepository } from "@database/repositories/utxo-repository";
import type { Output, Input, UTXO } from "@shared/blockchain";
import type { DatabaseManager } from "@services/database-manager";

// Mock database implementation for testing
class MockDatabaseConnection {
    private tables: Map<string, any[]> = new Map();
    private closed = false;

    constructor() {
        this.tables.set('blocks', []);
        this.tables.set('transactions', []);
        this.tables.set('transaction_outputs', []);
    }

    async query(text: string, params: any[] = []): Promise<any> {
        if (this.closed) {
            throw new Error('Cannot use a pool after calling end on the pool');
        }

        const sql = text.trim().toLowerCase();

        
        if (sql.startsWith('create table')) {
            // Mock table creation - just return success
            return { rows: [] };
        }
        
        if (sql.startsWith('insert into blocks')) {
            const blocks = this.tables.get('blocks')!;
            blocks.push({
                height: params[0],
                id: params[1],
                transaction_count: params[2],
                created_at: new Date()
            });
            return { rowCount: 1 };
        }
        
        if (sql.startsWith('insert into transactions')) {
            const transactions = this.tables.get('transactions')!;
            transactions.push({
                id: params[0],
                block_height: params[1],
                transaction_index: params[2]
            });
            return { rowCount: 1 };
        }
        
        if (sql.startsWith('insert into transaction_outputs')) {
            const outputs = this.tables.get('transaction_outputs')!;
            const newOutput = {
                id: outputs.length + 1,
                transaction_id: params[0],
                output_index: params[1],
                address: params[2],
                value: params[3],
                is_spent: params[4] ? 1 : 0,
                spent_by_tx_id: params[5],
                spent_at_height: params[6]
            };
            outputs.push(newOutput);
            return { rowCount: 1 };
        }
        
        // Rollback UPDATE query (must come before generic UPDATE)
        if (sql.includes('update transaction_outputs') && 
            sql.includes('set is_spent = false') && 
            sql.includes('where spent_at_height > $1')) {
            const outputs = this.tables.get('transaction_outputs')!;
            let updatedCount = 0;
            
            for (const output of outputs) {
                if (output.spent_at_height && output.spent_at_height > params[0]) {
                    output.is_spent = 0;
                    output.spent_by_tx_id = null;
                    output.spent_at_height = null;
                    updatedCount++;
                }
            }
            
            return { rowCount: updatedCount };
        }
        
        if (sql.startsWith('update transaction_outputs')) {
            const outputs = this.tables.get('transaction_outputs')!;
            let updatedCount = 0;
            
            for (const output of outputs) {
                if (output.transaction_id === params[2] && 
                    output.output_index === params[3] && 
                    output.is_spent === 0) {
                    output.is_spent = 1;
                    output.spent_by_tx_id = params[0];
                    output.spent_at_height = params[1];
                    updatedCount++;
                }
            }
            
            return { rowCount: updatedCount };
        }
        
        if (sql.includes('select') && sql.includes('transaction_outputs') && !sql.includes('delete')) {
            const outputs = this.tables.get('transaction_outputs')!;
            
            if (sql.includes('where transaction_id = $1 and output_index = $2')) {
                const result = outputs.find(o => 
                    o.transaction_id === params[0] && o.output_index === params[1]
                );
                if (result) {
                    // Convert to the format expected by getUTXO
                    const converted = {
                        tx_id: result.transaction_id,
                        index: result.output_index,
                        address: result.address,
                        value: result.value,
                        is_spent: result.is_spent === 1, // Convert to boolean
                        spent_by_tx_id: result.spent_by_tx_id,
                        spent_at_height: result.spent_at_height
                    };
                    return { rows: [converted] };
                }
                return { rows: [] };
            }
            
            if (sql.includes('where transaction_id = $1')) {
                const results = outputs.filter(o => o.transaction_id === params[0]);
                return { rows: results };
            }
            
            if (sql.includes('where address = $1 and is_spent = false')) {
                const results = outputs.filter(o => 
                    o.address === params[0] && o.is_spent === 0
                ).map(o => ({
                    tx_id: o.transaction_id,
                    index: o.output_index,
                    address: o.address,
                    value: o.value,
                    is_spent: o.is_spent === 1, // Convert to boolean
                    spent_by_tx_id: o.spent_by_tx_id,
                    spent_at_height: o.spent_at_height
                })).sort((a, b) => {
                    // Sort by transaction_id, then by index
                    if (a.tx_id !== b.tx_id) {
                        return a.tx_id.localeCompare(b.tx_id);
                    }
                    return a.index - b.index;
                });
                return { rows: results };
            }
            
            if (sql.includes('count(*)')) {
                return { rows: [{ count: outputs.length }] };
            }
            
            return { rows: outputs };
        }
        
        if (sql.includes('select') && sql.includes('max(height)')) {
            const blocks = this.tables.get('blocks')!;
            const maxHeight = blocks.length > 0 ? Math.max(...blocks.map(b => b.height)) : 0;
            return { rows: [{ max_height: maxHeight }] };
        }
        
        if (sql.includes('delete from transaction_outputs') && 
            sql.includes('where transaction_id in') && 
            sql.includes('select t.id') &&
            sql.includes('from transactions t') &&
            sql.includes('where t.block_height > $1')) {
            const outputs = this.tables.get('transaction_outputs')!;
            const transactions = this.tables.get('transactions')!;
            
            // Find transactions with block_height > target
            const txsToDelete = transactions.filter(t => t.block_height > params[0]);
            const txIdsToDelete = txsToDelete.map(t => t.id);
            
            // Remove outputs for those transactions
            const initialLength = outputs.length;
            const remainingOutputs = outputs.filter(o => !txIdsToDelete.includes(o.transaction_id));
            this.tables.set('transaction_outputs', remainingOutputs);
            
            return { rowCount: initialLength - remainingOutputs.length };
        }
        
        if (sql.startsWith('delete from blocks')) {
            const blocks = this.tables.get('blocks')!;
            const initialLength = blocks.length;
            this.tables.set('blocks', []);
            return { rowCount: initialLength };
        }
        
        if (sql.startsWith('delete from')) {
            // Handle other delete operations
            return { rowCount: 0 };
        }
        
        return { rows: [] };
    }

    getPool() {
        return this;
    }

    async close(): Promise<void> {
        if (this.closed) {
            throw new Error('Called end on pool more than once');
        }
        this.closed = true;
    }
}

describe("UTXO Repository", () => {
    let db: MockDatabaseConnection;
    let mockDbManager: DatabaseManager;
    let utxoRepository: UTXORepository;

    beforeEach(async () => {
        db = new MockDatabaseConnection();
        
        // Create mock DatabaseManager
        mockDbManager = {
            getConnection: vi.fn(() => db as any),
            getConnectionWithRetry: vi.fn(async () => db as any),
            isConnected: vi.fn(() => true),
            getStatus: vi.fn(() => ({ connected: true })),
            initialize: vi.fn(),
            shutdown: vi.fn()
        } as any;
        
        utxoRepository = new UTXORepository(mockDbManager);

        // Create test tables (mocked)
        await db.query(`CREATE TABLE IF NOT EXISTS blocks`);
        await db.query(`CREATE TABLE IF NOT EXISTS transactions`);
        await db.query(`CREATE TABLE IF NOT EXISTS transaction_outputs`);

        // Insert test block and transaction for foreign key constraints
        await db.query("INSERT INTO blocks", [1, 'block1', 1]);
        await db.query("INSERT INTO transactions", ['tx1', 1, 0]);
    });

    afterEach(async () => {
        await db.close();
    });

    describe("saveUTXOs", () => {
        test("should save single UTXO correctly", async () => {
            const outputs: Output[] = [
                { address: "addr1", value: 50.0 }
            ];

            await utxoRepository.saveUTXOs(outputs, "tx1", 1);

            const result = await db.query(
                "SELECT * FROM transaction_outputs WHERE transaction_id = $1",
                ["tx1"]
            );

            expect(result.rows).toHaveLength(1);
            expect(result.rows[0]).toMatchObject({
                transaction_id: "tx1",
                output_index: 0,
                address: "addr1",
                value: "50",
                is_spent: 0, // Mock uses 0/1 for boolean
                spent_by_tx_id: null,
                spent_at_height: null
            });
        });

        test("should save multiple UTXOs with correct indices", async () => {
            const outputs: Output[] = [
                { address: "addr1", value: 30.0 },
                { address: "addr2", value: 20.0 },
                { address: "addr3", value: 15.5 }
            ];

            await utxoRepository.saveUTXOs(outputs, "tx1", 1);

            const result = await db.query(
                "SELECT * FROM transaction_outputs WHERE transaction_id = $1 ORDER BY output_index",
                ["tx1"]
            );

            expect(result.rows).toHaveLength(3);
            expect(result.rows[0]).toMatchObject({
                output_index: 0,
                address: "addr1",
                value: "30"
            });
            expect(result.rows[1]).toMatchObject({
                output_index: 1,
                address: "addr2", 
                value: "20"
            });
            expect(result.rows[2]).toMatchObject({
                output_index: 2,
                address: "addr3",
                value: "15.5"
            });
        });

        test("should handle decimal values correctly", async () => {
            const outputs: Output[] = [
                { address: "addr1", value: 0.12345678 }
            ];

            await utxoRepository.saveUTXOs(outputs, "tx1", 1);

            const result = await db.query(
                "SELECT value FROM transaction_outputs WHERE transaction_id = $1",
                ["tx1"]
            );

            expect(result.rows[0].value).toBe("0.12345678");
        });

        test("should handle zero value UTXOs", async () => {
            const outputs: Output[] = [
                { address: "addr1", value: 0 }
            ];

            await utxoRepository.saveUTXOs(outputs, "tx1", 1);

            const result = await db.query(
                "SELECT value FROM transaction_outputs WHERE transaction_id = $1",
                ["tx1"]
            );

            expect(result.rows[0].value).toBe("0");
        });

        test("should handle empty outputs array", async () => {
            const outputs: Output[] = [];

            await utxoRepository.saveUTXOs(outputs, "tx1", 1);

            const result = await db.query(
                "SELECT * FROM transaction_outputs WHERE transaction_id = $1",
                ["tx1"]
            );

            expect(result.rows).toHaveLength(0);
        });
    });

    describe("spendUTXOs", () => {
        beforeEach(async () => {
            // Create some UTXOs to spend
            const outputs: Output[] = [
                { address: "addr1", value: 50.0 },
                { address: "addr2", value: 30.0 }
            ];
            await utxoRepository.saveUTXOs(outputs, "tx1", 1);

            // Add another transaction for testing
            await db.query("INSERT INTO transactions", ["tx2", 1, 1]);
        });

        test("should mark single UTXO as spent", async () => {
            const inputs: Input[] = [
                { txId: "tx1", index: 0 }
            ];

            await utxoRepository.spendUTXOs(inputs, "tx2", 1);

            const result = await db.query(
                "SELECT * FROM transaction_outputs WHERE transaction_id = $1 AND output_index = $2",
                ["tx1", 0]
            );

            expect(result.rows[0]).toMatchObject({
                is_spent: true, // The mock converts to boolean
                spent_by_tx_id: "tx2",
                spent_at_height: 1
            });
        });

        test("should mark multiple UTXOs as spent", async () => {
            const inputs: Input[] = [
                { txId: "tx1", index: 0 },
                { txId: "tx1", index: 1 }
            ];

            await utxoRepository.spendUTXOs(inputs, "tx2", 1);

            const result = await db.query(
                "SELECT * FROM transaction_outputs WHERE transaction_id = $1 ORDER BY output_index",
                ["tx1"]
            );

            expect(result.rows).toHaveLength(2);
            expect(result.rows[0]).toMatchObject({
                is_spent: 1, // Raw database format for this query
                spent_by_tx_id: "tx2",
                spent_at_height: 1
            });
            expect(result.rows[1]).toMatchObject({
                is_spent: 1, // Raw database format for this query
                spent_by_tx_id: "tx2",
                spent_at_height: 1
            });
        });

        test("should throw error when trying to spend non-existent UTXO", async () => {
            const inputs: Input[] = [
                { txId: "non_existent", index: 0 }
            ];

            await expect(
                utxoRepository.spendUTXOs(inputs, "tx2", 1)
            ).rejects.toThrow("UTXO not found or already spent: txId=non_existent, index=0");
        });

        test("should throw error when trying to spend already spent UTXO", async () => {
            const inputs: Input[] = [
                { txId: "tx1", index: 0 }
            ];

            // Spend it once
            await utxoRepository.spendUTXOs(inputs, "tx2", 1);

            // Try to spend it again
            await expect(
                utxoRepository.spendUTXOs(inputs, "tx3", 1)
            ).rejects.toThrow("UTXO not found or already spent: txId=tx1, index=0");
        });

        test("should handle empty inputs array", async () => {
            const inputs: Input[] = [];

            // Should not throw error
            await expect(
                utxoRepository.spendUTXOs(inputs, "tx2", 1)
            ).resolves.not.toThrow();
        });
    });

    describe("getUTXO", () => {
        beforeEach(async () => {
            // Create test UTXOs
            const outputs: Output[] = [
                { address: "addr1", value: 50.0 },
                { address: "addr2", value: 30.0 }
            ];
            await utxoRepository.saveUTXOs(outputs, "tx1", 1);
        });

        test("should retrieve existing unspent UTXO", async () => {
            const utxo = await utxoRepository.getUTXO("tx1", 0);

            expect(utxo).toMatchObject({
                txId: "tx1",
                index: 0,
                address: "addr1",
                value: 50.0,
                isSpent: false,
                spentByTxId: undefined,
                spentAtHeight: undefined
            });
        });

        test("should retrieve existing spent UTXO", async () => {
            // First spend the UTXO
            await db.query("INSERT INTO transactions", ["tx2", 1, 1]);
            await utxoRepository.spendUTXOs([{ txId: "tx1", index: 0 }], "tx2", 1);

            const utxo = await utxoRepository.getUTXO("tx1", 0);

            expect(utxo).toMatchObject({
                txId: "tx1",
                index: 0,
                address: "addr1",
                value: 50.0,
                isSpent: true,
                spentByTxId: "tx2",
                spentAtHeight: 1
            });
        });

        test("should return null for non-existent UTXO", async () => {
            const utxo = await utxoRepository.getUTXO("non_existent", 0);

            expect(utxo).toBeNull();
        });

        test("should return null for invalid index", async () => {
            const utxo = await utxoRepository.getUTXO("tx1", 999);

            expect(utxo).toBeNull();
        });
    });

    describe("getUnspentUTXOsForAddress", () => {
        beforeEach(async () => {
            // Create UTXOs for different addresses
            await db.query("INSERT INTO transactions", ["tx2", 1, 1]);
            await db.query("INSERT INTO transactions", ["tx3", 1, 2]);

            const outputs1: Output[] = [
                { address: "addr1", value: 50.0 },
                { address: "addr2", value: 30.0 }
            ];
            await utxoRepository.saveUTXOs(outputs1, "tx1", 1);

            const outputs2: Output[] = [
                { address: "addr1", value: 25.0 },
                { address: "addr3", value: 15.0 }
            ];
            await utxoRepository.saveUTXOs(outputs2, "tx2", 1);

            // Spend one UTXO
            await utxoRepository.spendUTXOs([{ txId: "tx1", index: 0 }], "tx3", 1);
        });

        test("should return all unspent UTXOs for address", async () => {
            const utxos = await utxoRepository.getUnspentUTXOsForAddress("addr1");

            expect(utxos).toHaveLength(1); // tx1:0 is spent, only tx2:0 remains
            expect(utxos[0]).toMatchObject({
                txId: "tx2",
                index: 0,
                address: "addr1",
                value: 25.0,
                isSpent: false
            });
        });

        test("should return empty array for address with no UTXOs", async () => {
            const utxos = await utxoRepository.getUnspentUTXOsForAddress("addr_no_utxos");

            expect(utxos).toHaveLength(0);
        });

        test("should return empty array for address with only spent UTXOs", async () => {
            // Spend all UTXOs for addr2
            await utxoRepository.spendUTXOs([{ txId: "tx1", index: 1 }], "tx3", 1);

            const utxos = await utxoRepository.getUnspentUTXOsForAddress("addr2");

            expect(utxos).toHaveLength(0);
        });

        test("should return UTXOs sorted by transaction ID and index", async () => {
            // Create more UTXOs to test sorting
            await db.query("INSERT INTO transactions", ["tx0", 1, 3]);
            const outputs: Output[] = [
                { address: "addr1", value: 10.0 }
            ];
            await utxoRepository.saveUTXOs(outputs, "tx0", 1);

            const utxos = await utxoRepository.getUnspentUTXOsForAddress("addr1");

            expect(utxos).toHaveLength(2);
            expect(utxos[0].txId).toBe("tx0"); // Should come first alphabetically
            expect(utxos[1].txId).toBe("tx2");
        });
    });

    describe("rollbackUTXOsAfterHeight", () => {
        beforeEach(async () => {
            // Create test data across multiple blocks
            await db.query("INSERT INTO blocks", [2, 'block2', 2]);
            await db.query("INSERT INTO blocks", [3, 'block3', 1]);

            await db.query("INSERT INTO transactions", ["tx2", 2, 0]);
            await db.query("INSERT INTO transactions", ["tx3", 2, 1]);
            await db.query("INSERT INTO transactions", ["tx4", 3, 0]);

            // Block 1: Create initial UTXOs
            const outputs1: Output[] = [
                { address: "addr1", value: 100.0 },
                { address: "addr2", value: 50.0 }
            ];
            await utxoRepository.saveUTXOs(outputs1, "tx1", 1);

            // Block 2: Create more UTXOs and spend some from block 1
            const outputs2: Output[] = [
                { address: "addr3", value: 75.0 }
            ];
            await utxoRepository.saveUTXOs(outputs2, "tx2", 2);

            // Spend UTXO from block 1 in block 2
            await utxoRepository.spendUTXOs([{ txId: "tx1", index: 0 }], "tx3", 2);

            // Block 3: Create more UTXOs and spend some from block 2
            const outputs3: Output[] = [
                { address: "addr4", value: 25.0 }
            ];
            await utxoRepository.saveUTXOs(outputs3, "tx4", 3);

            // Spend UTXO from block 2 in block 3
            await utxoRepository.spendUTXOs([{ txId: "tx2", index: 0 }], "tx4", 3);
        });

        test("should unspend UTXOs that were spent after target height", async () => {
            // Rollback to height 1 - should unspend tx1:0 (spent in block 2)
            await utxoRepository.rollbackUTXOsAfterHeight(1);

            const utxo = await utxoRepository.getUTXO("tx1", 0);
            expect(utxo).toMatchObject({
                txId: "tx1",
                index: 0,
                isSpent: false,
                spentByTxId: undefined,
                spentAtHeight: undefined
            });
        });

        test("should remove UTXOs created after target height", async () => {
            // Rollback to height 1 - should remove UTXOs from blocks 2 and 3
            await utxoRepository.rollbackUTXOsAfterHeight(1);

            // UTXOs from tx2 (block 2) should be removed
            const utxo2 = await utxoRepository.getUTXO("tx2", 0);
            expect(utxo2).toBeNull();

            // UTXOs from tx4 (block 3) should be removed
            const utxo4 = await utxoRepository.getUTXO("tx4", 0);
            expect(utxo4).toBeNull();

            // UTXOs from tx1 (block 1) should remain
            const utxo1 = await utxoRepository.getUTXO("tx1", 1);
            expect(utxo1).not.toBeNull();
        });

        test("should handle rollback to height 0", async () => {
            // Rollback to height 0 - should remove all UTXOs and unspend everything
            await utxoRepository.rollbackUTXOsAfterHeight(0);

            // All UTXOs should be removed
            const result = await db.query("SELECT COUNT(*) as count FROM transaction_outputs");
            expect(result.rows[0].count).toBe(0);
        });

        test("should handle rollback to current height", async () => {
            // Get initial state
            const initialUtxos = await db.query("SELECT * FROM transaction_outputs ORDER BY transaction_id, output_index");
            
            // Rollback to height 3 (current height) - should not change anything
            await utxoRepository.rollbackUTXOsAfterHeight(3);

            const finalUtxos = await db.query("SELECT * FROM transaction_outputs ORDER BY transaction_id, output_index");
            expect(finalUtxos.rows).toEqual(initialUtxos.rows);
        });

        test("should handle rollback to intermediate height", async () => {
            // Rollback to height 2 - should only affect block 3
            await utxoRepository.rollbackUTXOsAfterHeight(2);

            // UTXO from tx4 (block 3) should be removed
            const utxo4 = await utxoRepository.getUTXO("tx4", 0);
            expect(utxo4).toBeNull();

            // UTXO from tx2 (block 2) that was spent in block 3 should be unspent
            const utxo2 = await utxoRepository.getUTXO("tx2", 0);
            expect(utxo2).toMatchObject({
                isSpent: false,
                spentByTxId: undefined,
                spentAtHeight: undefined
            });

            // UTXO from tx1 (block 1) that was spent in block 2 should remain spent
            const utxo1 = await utxoRepository.getUTXO("tx1", 0);
            expect(utxo1).toMatchObject({
                isSpent: true,
                spentByTxId: "tx3",
                spentAtHeight: 2
            });
        });

        test("should handle complex rollback scenario with multiple spending chains", async () => {
            // Create a more complex scenario
            await db.query("INSERT INTO blocks", [4, 'block4', 1]);
            await db.query("INSERT INTO transactions", ["tx5", 4, 0]);

            // Block 4: Spend the UTXO that was unspent after block 3 rollback
            const outputs4: Output[] = [
                { address: "addr5", value: 10.0 }
            ];
            await utxoRepository.saveUTXOs(outputs4, "tx5", 4);

            // Now rollback to height 2
            await utxoRepository.rollbackUTXOsAfterHeight(2);

            // Verify state after rollback
            const utxos = await db.query("SELECT * FROM transaction_outputs ORDER BY transaction_id, output_index");
            
            // Should have UTXOs from blocks 1 and 2 only
            const txIds = utxos.rows.map((row: any) => row.transaction_id);
            expect(txIds).toContain("tx1");
            expect(txIds).toContain("tx2");
            expect(txIds).not.toContain("tx4");
            expect(txIds).not.toContain("tx5");
        });
    });

    describe("getCurrentHeight", () => {
        test("should return 0 when no blocks exist", async () => {
            // Clear all blocks
            await db.query("DELETE FROM blocks");

            const height = await utxoRepository.getCurrentHeight();
            expect(height).toBe(0);
        });

        test("should return highest block height", async () => {
            // Add more blocks
            await db.query("INSERT INTO blocks", [2, 'block2', 1]);
            await db.query("INSERT INTO blocks", [5, 'block5', 1]);
            await db.query("INSERT INTO blocks", [3, 'block3', 1]);

            const height = await utxoRepository.getCurrentHeight();
            expect(height).toBe(5);
        });
    });

    describe("Edge Cases and Error Handling", () => {
        test("should handle very large UTXO values", async () => {
            const outputs: Output[] = [
                { address: "addr1", value: 999999999.99999999 }
            ];

            await utxoRepository.saveUTXOs(outputs, "tx1", 1);

            const utxo = await utxoRepository.getUTXO("tx1", 0);
            expect(utxo?.value).toBe(999999999.99999999);
        });

        test("should handle special characters in addresses", async () => {
            const outputs: Output[] = [
                { address: "addr_with-special.chars@123", value: 50.0 }
            ];

            await utxoRepository.saveUTXOs(outputs, "tx1", 1);

            const utxo = await utxoRepository.getUTXO("tx1", 0);
            expect(utxo?.address).toBe("addr_with-special.chars@123");
        });

        test("should handle very long transaction IDs", async () => {
            const longTxId = "a".repeat(1000);
            await db.query("INSERT INTO transactions", [longTxId, 1, 1]);

            const outputs: Output[] = [
                { address: "addr1", value: 50.0 }
            ];

            await utxoRepository.saveUTXOs(outputs, longTxId, 1);

            const utxo = await utxoRepository.getUTXO(longTxId, 0);
            expect(utxo?.txId).toBe(longTxId);
        });

        test("should handle concurrent UTXO operations", async () => {
            const outputs: Output[] = [
                { address: "addr1", value: 50.0 }
            ];

            // Simulate concurrent saves
            const promises = [];
            for (let i = 0; i < 5; i++) {
                const txId = `concurrent_tx_${i}`;
                await db.query("INSERT INTO transactions", [txId, 1, i + 1]);
                promises.push(utxoRepository.saveUTXOs(outputs, txId, 1));
            }

            await Promise.all(promises);

            // Verify all UTXOs were saved
            const result = await db.query("SELECT COUNT(*) as count FROM transaction_outputs");
            expect(result.rows[0].count).toBe(5);
        });
    });
});