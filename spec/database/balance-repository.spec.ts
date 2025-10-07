import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { BalanceRepository } from "@database/repositories/balance-repository";
import type { Balance, BalanceUpdate } from "@shared/blockchain";
import type { DatabaseManager } from "@services/database-manager";

// Mock database connection for testing balance operations
class MockDatabaseConnection {
    private balances: Map<string, { balance: string; last_updated_height: number }> = new Map();
    private outputs: Array<{ address: string; value: string; is_spent: boolean }> = [];
    private blocks: Array<{ height: number }> = [];
    private closed = false;

    async query(text: string, params: any[] = []): Promise<any> {
        if (this.closed) {
            throw new Error('Cannot use a pool after calling end on the pool');
        }

        const sql = text.trim().toLowerCase().replace(/\s+/g, ' ');
        // Recalculation INSERT...SELECT query (must come before regular INSERT)
        if (sql.includes('insert into balances') && sql.includes('select address, sum(cast(value as decimal')) {
            const addressTotals = new Map<string, number>();
            
            this.outputs
                .filter(o => !o.is_spent)
                .forEach(o => {
                    const current = addressTotals.get(o.address) || 0;
                    addressTotals.set(o.address, current + parseFloat(o.value));
                });
            
            for (const [address, total] of addressTotals) {
                if (total > 0) {
                    this.balances.set(address, {
                        balance: total.toString(),
                        last_updated_height: 0
                    });
                }
            }
            return { rows: [] };
        }
        
        // Balance queries
        if (sql.includes('select balance from balances where address =')) {
            const balance = this.balances.get(params[0]);
            return balance ? { rows: [{ balance: balance.balance }] } : { rows: [] };
        }
        
        // Balance upserts (INSERT ... ON CONFLICT)
        if (sql.includes('insert into balances') && sql.includes('on conflict')) {
            if (params.length === 3) {
                this.balances.set(params[0], {
                    balance: params[1].toString(),
                    last_updated_height: params[2]
                });
                return { rowCount: 1 };
            } else {
                // Batch updates
                for (let i = 0; i < params.length; i += 3) {
                    this.balances.set(params[i], {
                        balance: params[i + 1].toString(),
                        last_updated_height: params[i + 2]
                    });
                }
                return { rowCount: params.length / 3 };
            }
        }
        
        // Get all balances
        if (sql.includes('select address, balance, last_updated_height from balances') && sql.includes('order by address') && !sql.includes('where')) {
            return {
                rows: Array.from(this.balances.entries())
                    .map(([address, data]) => ({
                        address,
                        balance: data.balance,
                        last_updated_height: data.last_updated_height
                    }))
                    .sort((a, b) => a.address.localeCompare(b.address))
            };
        }
        
        // Get specific balances
        if (sql.includes('select address, balance, last_updated_height from balances') && sql.includes('where address in')) {
            const filtered = Array.from(this.balances.entries())
                .filter(([address]) => params.includes(address));
            return {
                rows: filtered
                    .map(([address, data]) => ({
                        address,
                        balance: data.balance,
                        last_updated_height: data.last_updated_height
                    }))
                    .sort((a, b) => a.address.localeCompare(b.address))
            };
        }
        
        // UTXO balance calculations
        if (sql.includes('sum(cast(value as decimal') && sql.includes('from transaction_outputs')) {
            if (sql.includes('where address =') && sql.includes('and is_spent = false')) {
                const total = this.outputs
                    .filter(o => o.address === params[0] && !o.is_spent)
                    .reduce((sum, o) => sum + parseFloat(o.value), 0);
                return { rows: [{ balance: total.toString() }] };
            }
        }
        
        // Balance reset (for recalculation)
        if (sql.includes('update balances set balance = 0')) {
            for (const [address, data] of this.balances) {
                this.balances.set(address, {
                    balance: '0',
                    last_updated_height: 0
                });
            }
            return { rowCount: this.balances.size };
        }
        
        // Balance cleanup
        if (sql.includes('delete from balances where balance = 0')) {
            let count = 0;
            for (const [address, data] of this.balances) {
                if (parseFloat(data.balance) === 0) {
                    this.balances.delete(address);
                    count++;
                }
            }
            return { rowCount: count };
        }
        
        // Address deletion
        if (sql.includes('delete from balances where address =')) {
            const existed = this.balances.delete(params[0]);
            return { rowCount: existed ? 1 : 0 };
        }
        
        // Max height query
        if (sql.includes('max(height)') && sql.includes('from blocks')) {
            const maxHeight = this.blocks.length > 0 ? Math.max(...this.blocks.map(b => b.height)) : 0;
            return { rows: [{ max_height: maxHeight }] };
        }
        
        // Test setup helpers
        if (sql.startsWith('insert into blocks')) {
            this.blocks.push({ height: params[0] });
            return { rowCount: 1 };
        }
        
        if (sql.startsWith('insert into transaction_outputs')) {
            this.outputs.push({
                address: params[0],
                value: params[1],
                is_spent: params[2] || false
            });
            return { rowCount: 1 };
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
    
    clearOutputs() {
        this.outputs = [];
    }
}

describe("Balance Repository", () => {
    let db: MockDatabaseConnection;
    let mockDbManager: DatabaseManager;
    let balanceRepository: BalanceRepository;

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
        
        balanceRepository = new BalanceRepository(mockDbManager);

        // Create test tables (mocked)
        await db.query(`CREATE TABLE IF NOT EXISTS balances`);
        await db.query(`CREATE TABLE IF NOT EXISTS blocks`);
        await db.query(`CREATE TABLE IF NOT EXISTS transaction_outputs`);
    });

    afterEach(async () => {
        await db.close();
    });

    describe("getBalance", () => {
        test("should return 0 for address with no balance record", async () => {
            const balance = await balanceRepository.getBalance("addr_no_balance");
            expect(balance).toBe(0);
        });

        test("should return correct balance for existing address", async () => {
            // Set up test data
            await balanceRepository.updateBalance("addr1", 50.5, 1);
            
            const balance = await balanceRepository.getBalance("addr1");
            expect(balance).toBe(50.5);
        });

        test("should handle decimal precision correctly", async () => {
            await balanceRepository.updateBalance("addr1", 0.12345678, 1);
            
            const balance = await balanceRepository.getBalance("addr1");
            expect(balance).toBe(0.12345678);
        });

        test("should handle zero balance", async () => {
            await balanceRepository.updateBalance("addr1", 0, 1);
            
            const balance = await balanceRepository.getBalance("addr1");
            expect(balance).toBe(0);
        });

        test("should handle large balance values", async () => {
            const largeBalance = 999999999.99999999;
            await balanceRepository.updateBalance("addr1", largeBalance, 1);
            
            const balance = await balanceRepository.getBalance("addr1");
            expect(balance).toBe(largeBalance);
        });
    });

    describe("updateBalance", () => {
        test("should create new balance record for new address", async () => {
            await balanceRepository.updateBalance("addr1", 100.0, 1);
            
            const balance = await balanceRepository.getBalance("addr1");
            expect(balance).toBe(100.0);
        });

        test("should update existing balance record", async () => {
            // Create initial balance
            await balanceRepository.updateBalance("addr1", 50.0, 1);
            
            // Update balance
            await balanceRepository.updateBalance("addr1", 75.5, 2);
            
            const balance = await balanceRepository.getBalance("addr1");
            expect(balance).toBe(75.5);
        });

        test("should handle balance updates to zero", async () => {
            await balanceRepository.updateBalance("addr1", 100.0, 1);
            await balanceRepository.updateBalance("addr1", 0, 2);
            
            const balance = await balanceRepository.getBalance("addr1");
            expect(balance).toBe(0);
        });

        test("should handle negative balance updates", async () => {
            await balanceRepository.updateBalance("addr1", -25.5, 1);
            
            const balance = await balanceRepository.getBalance("addr1");
            expect(balance).toBe(-25.5);
        });

        test("should handle multiple addresses independently", async () => {
            await balanceRepository.updateBalance("addr1", 100.0, 1);
            await balanceRepository.updateBalance("addr2", 200.0, 1);
            await balanceRepository.updateBalance("addr3", 300.0, 1);
            
            expect(await balanceRepository.getBalance("addr1")).toBe(100.0);
            expect(await balanceRepository.getBalance("addr2")).toBe(200.0);
            expect(await balanceRepository.getBalance("addr3")).toBe(300.0);
        });
    });

    describe("batchUpdateBalances", () => {
        test("should handle empty updates array", async () => {
            const updates: BalanceUpdate[] = [];
            
            // Should not throw error
            await expect(
                balanceRepository.batchUpdateBalances(updates, 1)
            ).resolves.not.toThrow();
        });

        test("should update multiple balances in single operation", async () => {
            const updates: BalanceUpdate[] = [
                { address: "addr1", amount: 100.0 },
                { address: "addr2", amount: 200.0 },
                { address: "addr3", amount: 300.0 }
            ];
            
            await balanceRepository.batchUpdateBalances(updates, 1);
            
            expect(await balanceRepository.getBalance("addr1")).toBe(100.0);
            expect(await balanceRepository.getBalance("addr2")).toBe(200.0);
            expect(await balanceRepository.getBalance("addr3")).toBe(300.0);
        });

        test("should update existing balances in batch", async () => {
            // Set initial balances
            await balanceRepository.updateBalance("addr1", 50.0, 1);
            await balanceRepository.updateBalance("addr2", 75.0, 1);
            
            const updates: BalanceUpdate[] = [
                { address: "addr1", amount: 150.0 },
                { address: "addr2", amount: 250.0 }
            ];
            
            await balanceRepository.batchUpdateBalances(updates, 2);
            
            expect(await balanceRepository.getBalance("addr1")).toBe(150.0);
            expect(await balanceRepository.getBalance("addr2")).toBe(250.0);
        });

        test("should handle mix of new and existing addresses", async () => {
            // Set initial balance for one address
            await balanceRepository.updateBalance("addr1", 50.0, 1);
            
            const updates: BalanceUpdate[] = [
                { address: "addr1", amount: 150.0 }, // Update existing
                { address: "addr2", amount: 200.0 }  // Create new
            ];
            
            await balanceRepository.batchUpdateBalances(updates, 2);
            
            expect(await balanceRepository.getBalance("addr1")).toBe(150.0);
            expect(await balanceRepository.getBalance("addr2")).toBe(200.0);
        });

        test("should handle decimal values in batch updates", async () => {
            const updates: BalanceUpdate[] = [
                { address: "addr1", amount: 0.12345678 },
                { address: "addr2", amount: 999.87654321 }
            ];
            
            await balanceRepository.batchUpdateBalances(updates, 1);
            
            expect(await balanceRepository.getBalance("addr1")).toBe(0.12345678);
            expect(await balanceRepository.getBalance("addr2")).toBe(999.87654321);
        });

        test("should handle zero and negative values in batch", async () => {
            const updates: BalanceUpdate[] = [
                { address: "addr1", amount: 0 },
                { address: "addr2", amount: -50.5 },
                { address: "addr3", amount: 100.0 }
            ];
            
            await balanceRepository.batchUpdateBalances(updates, 1);
            
            expect(await balanceRepository.getBalance("addr1")).toBe(0);
            expect(await balanceRepository.getBalance("addr2")).toBe(-50.5);
            expect(await balanceRepository.getBalance("addr3")).toBe(100.0);
        });

        test("should handle large batch updates", async () => {
            const updates: BalanceUpdate[] = [];
            for (let i = 0; i < 100; i++) {
                updates.push({ address: `addr${i}`, amount: i * 10.5 });
            }
            
            await balanceRepository.batchUpdateBalances(updates, 1);
            
            // Verify a few random addresses
            expect(await balanceRepository.getBalance("addr0")).toBe(0);
            expect(await balanceRepository.getBalance("addr10")).toBe(105.0);
            expect(await balanceRepository.getBalance("addr99")).toBe(1039.5);
        });
    });

    describe("getAllBalances", () => {
        test("should return empty array when no balances exist", async () => {
            const balances = await balanceRepository.getAllBalances();
            expect(balances).toEqual([]);
        });

        test("should return all balance records sorted by address", async () => {
            await balanceRepository.updateBalance("addr3", 300.0, 1);
            await balanceRepository.updateBalance("addr1", 100.0, 2);
            await balanceRepository.updateBalance("addr2", 200.0, 3);
            
            const balances = await balanceRepository.getAllBalances();
            
            expect(balances).toHaveLength(3);
            expect(balances[0]).toMatchObject({
                address: "addr1",
                balance: 100.0,
                lastUpdatedHeight: 2
            });
            expect(balances[1]).toMatchObject({
                address: "addr2", 
                balance: 200.0,
                lastUpdatedHeight: 3
            });
            expect(balances[2]).toMatchObject({
                address: "addr3",
                balance: 300.0,
                lastUpdatedHeight: 1
            });
        });

        test("should include zero balances in results", async () => {
            await balanceRepository.updateBalance("addr1", 100.0, 1);
            await balanceRepository.updateBalance("addr2", 0, 1);
            
            const balances = await balanceRepository.getAllBalances();
            
            expect(balances).toHaveLength(2);
            expect(balances.find(b => b.address === "addr2")?.balance).toBe(0);
        });
    });

    describe("getBalancesForAddresses", () => {
        beforeEach(async () => {
            await balanceRepository.updateBalance("addr1", 100.0, 1);
            await balanceRepository.updateBalance("addr2", 200.0, 2);
            await balanceRepository.updateBalance("addr3", 300.0, 3);
        });

        test("should return empty array for empty address list", async () => {
            const balances = await balanceRepository.getBalancesForAddresses([]);
            expect(balances).toEqual([]);
        });

        test("should return balances for specified addresses", async () => {
            const balances = await balanceRepository.getBalancesForAddresses(["addr1", "addr3"]);
            
            expect(balances).toHaveLength(2);
            expect(balances[0]).toMatchObject({
                address: "addr1",
                balance: 100.0,
                lastUpdatedHeight: 1
            });
            expect(balances[1]).toMatchObject({
                address: "addr3",
                balance: 300.0,
                lastUpdatedHeight: 3
            });
        });

        test("should handle non-existent addresses gracefully", async () => {
            const balances = await balanceRepository.getBalancesForAddresses(["addr1", "addr_nonexistent", "addr3"]);
            
            expect(balances).toHaveLength(2);
            expect(balances.map(b => b.address)).toEqual(["addr1", "addr3"]);
        });

        test("should return results sorted by address", async () => {
            const balances = await balanceRepository.getBalancesForAddresses(["addr3", "addr1", "addr2"]);
            
            expect(balances).toHaveLength(3);
            expect(balances.map(b => b.address)).toEqual(["addr1", "addr2", "addr3"]);
        });
    });

    describe("recalculateAllBalances", () => {
        beforeEach(async () => {
            // Set up test UTXOs
            await db.query("INSERT INTO transaction_outputs", ["addr1", "50.0", false]);
            await db.query("INSERT INTO transaction_outputs", ["addr1", "30.0", false]);
            await db.query("INSERT INTO transaction_outputs", ["addr2", "100.0", false]);
            await db.query("INSERT INTO transaction_outputs", ["addr2", "25.0", true]); // spent
            await db.query("INSERT INTO transaction_outputs", ["addr3", "75.5", false]);
        });

        test("should recalculate all balances from unspent UTXOs", async () => {
            // Set some incorrect initial balances
            await balanceRepository.updateBalance("addr1", 999.0, 1);
            await balanceRepository.updateBalance("addr2", 888.0, 1);
            
            await balanceRepository.recalculateAllBalances();
            
            // Verify balances match UTXO sums
            expect(await balanceRepository.getBalance("addr1")).toBe(80.0); // 50 + 30
            expect(await balanceRepository.getBalance("addr2")).toBe(100.0); // 100 (25 is spent)
            expect(await balanceRepository.getBalance("addr3")).toBe(75.5);
        });

        test("should remove addresses with zero balance after recalculation", async () => {
            // Set up address with only spent UTXOs
            await db.query("INSERT INTO transaction_outputs", ["addr_zero", "50.0", true]);
            await balanceRepository.updateBalance("addr_zero", 50.0, 1);
            
            await balanceRepository.recalculateAllBalances();
            
            const balance = await balanceRepository.getBalance("addr_zero");
            expect(balance).toBe(0); // Should return 0 for non-existent record
        });

        test("should handle addresses with no UTXOs", async () => {
            await balanceRepository.updateBalance("addr_no_utxos", 100.0, 1);
            
            await balanceRepository.recalculateAllBalances();
            
            const balance = await balanceRepository.getBalance("addr_no_utxos");
            expect(balance).toBe(0);
        });

        test("should handle empty UTXO set", async () => {
            // Clear all UTXOs
            (db as any).clearOutputs();
            
            await balanceRepository.updateBalance("addr1", 100.0, 1);
            await balanceRepository.recalculateAllBalances();
            
            const balance = await balanceRepository.getBalance("addr1");
            expect(balance).toBe(0);
        });
    });

    describe("recalculateBalanceForAddress", () => {
        beforeEach(async () => {
            // Set up test UTXOs for specific address
            await db.query("INSERT INTO transaction_outputs", ["addr1", "50.0", false]);
            await db.query("INSERT INTO transaction_outputs", ["addr1", "30.0", false]);
            await db.query("INSERT INTO transaction_outputs", ["addr1", "20.0", true]); // spent
            await db.query("INSERT INTO transaction_outputs", ["addr2", "100.0", false]); // different address
        });

        test("should recalculate balance for specific address only", async () => {
            await balanceRepository.updateBalance("addr1", 999.0, 1);
            await balanceRepository.updateBalance("addr2", 888.0, 1);
            
            await balanceRepository.recalculateBalanceForAddress("addr1", 2);
            
            expect(await balanceRepository.getBalance("addr1")).toBe(80.0); // 50 + 30
            expect(await balanceRepository.getBalance("addr2")).toBe(888.0); // unchanged
        });

        test("should delete balance record when address has zero balance", async () => {
            await balanceRepository.updateBalance("addr_zero", 100.0, 1);
            
            // No unspent UTXOs for addr_zero
            await balanceRepository.recalculateBalanceForAddress("addr_zero", 2);
            
            const balance = await balanceRepository.getBalance("addr_zero");
            expect(balance).toBe(0); // Should return 0 for deleted record
        });

        test("should handle address with no UTXOs", async () => {
            await balanceRepository.updateBalance("addr_no_utxos", 50.0, 1);
            
            await balanceRepository.recalculateBalanceForAddress("addr_no_utxos", 2);
            
            const balance = await balanceRepository.getBalance("addr_no_utxos");
            expect(balance).toBe(0);
        });

        test("should handle address with only spent UTXOs", async () => {
            await db.query("INSERT INTO transaction_outputs", ["addr_spent", "25.0", true]);
            await balanceRepository.updateBalance("addr_spent", 25.0, 1);
            
            await balanceRepository.recalculateBalanceForAddress("addr_spent", 2);
            
            const balance = await balanceRepository.getBalance("addr_spent");
            expect(balance).toBe(0);
        });
    });

    describe("getCurrentHeight", () => {
        test("should return 0 when no blocks exist", async () => {
            const height = await balanceRepository.getCurrentHeight();
            expect(height).toBe(0);
        });

        test("should return highest block height", async () => {
            await db.query("INSERT INTO blocks", [1, "block1", 1]);
            await db.query("INSERT INTO blocks", [5, "block5", 1]);
            await db.query("INSERT INTO blocks", [3, "block3", 1]);
            
            const height = await balanceRepository.getCurrentHeight();
            expect(height).toBe(5);
        });
    });

    describe("Balance Calculation Accuracy", () => {
        test("should maintain precision with multiple decimal operations", async () => {
            const updates: BalanceUpdate[] = [
                { address: "addr1", amount: 0.1 },
                { address: "addr1", amount: 0.2 }
            ];
            
            // Apply updates sequentially to test accumulation
            await balanceRepository.batchUpdateBalances([updates[0]], 1);
            const intermediate = await balanceRepository.getBalance("addr1");
            expect(intermediate).toBe(0.1);
            
            await balanceRepository.batchUpdateBalances([updates[1]], 2);
            const final = await balanceRepository.getBalance("addr1");
            expect(final).toBe(0.2); // Last update overwrites, doesn't accumulate
        });

        test("should handle very small decimal values accurately", async () => {
            const smallValue = 0.00000001;
            await balanceRepository.updateBalance("addr1", smallValue, 1);
            
            const balance = await balanceRepository.getBalance("addr1");
            expect(balance).toBe(smallValue);
        });

        test("should handle very large values accurately", async () => {
            const largeValue = 21000000.99999999;
            await balanceRepository.updateBalance("addr1", largeValue, 1);
            
            const balance = await balanceRepository.getBalance("addr1");
            expect(balance).toBe(largeValue);
        });

        test("should maintain accuracy across multiple operations", async () => {
            // Simulate complex balance changes
            await balanceRepository.updateBalance("addr1", 100.12345678, 1);
            await balanceRepository.updateBalance("addr1", 200.87654321, 2);
            await balanceRepository.updateBalance("addr1", 50.5, 3);
            
            const balance = await balanceRepository.getBalance("addr1");
            expect(balance).toBe(50.5);
        });
    });

    describe("Edge Cases and Error Handling", () => {
        test("should handle special characters in addresses", async () => {
            const specialAddress = "addr_with-special.chars@123";
            await balanceRepository.updateBalance(specialAddress, 100.0, 1);
            
            const balance = await balanceRepository.getBalance(specialAddress);
            expect(balance).toBe(100.0);
        });

        test("should handle very long addresses", async () => {
            const longAddress = "a".repeat(1000);
            await balanceRepository.updateBalance(longAddress, 50.0, 1);
            
            const balance = await balanceRepository.getBalance(longAddress);
            expect(balance).toBe(50.0);
        });

        test("should handle concurrent balance operations", async () => {
            const updates: BalanceUpdate[] = [];
            for (let i = 0; i < 10; i++) {
                updates.push({ address: `concurrent_addr_${i}`, amount: i * 10.5 });
            }
            
            // Simulate concurrent batch updates
            const promises = [
                balanceRepository.batchUpdateBalances(updates.slice(0, 5), 1),
                balanceRepository.batchUpdateBalances(updates.slice(5, 10), 1)
            ];
            
            await Promise.all(promises);
            
            // Verify all balances were set
            for (let i = 0; i < 10; i++) {
                const balance = await balanceRepository.getBalance(`concurrent_addr_${i}`);
                expect(balance).toBe(i * 10.5);
            }
        });

        test("should handle balance updates with extreme values", async () => {
            const extremeValues = [
                Number.MAX_SAFE_INTEGER,
                Number.MIN_SAFE_INTEGER,
                Number.EPSILON,
                -Number.EPSILON
            ];
            
            for (let i = 0; i < extremeValues.length; i++) {
                const address = `extreme_addr_${i}`;
                await balanceRepository.updateBalance(address, extremeValues[i], 1);
                
                const balance = await balanceRepository.getBalance(address);
                expect(balance).toBe(extremeValues[i]);
            }
        });
    });
});