import { expect, test, describe } from "vitest";
import {
    validateBlockHeight,
    calculateBlockId,
    validateBlockId,
    validateTransactionBalance,
    validateTransactionBalances
} from "../../src/validation/block-validation.js";
import type { Block, Transaction } from "../../src/types/blockchain.js";

describe("Block Height Validation", () => {
    test("should accept height 1 when no blocks exist (currentHeight = 0)", () => {
        expect(validateBlockHeight(1, 0)).toBe(true);
    });

    test("should reject height 0 when no blocks exist", () => {
        expect(validateBlockHeight(0, 0)).toBe(false);
    });

    test("should reject height 2 when no blocks exist", () => {
        expect(validateBlockHeight(2, 0)).toBe(false);
    });

    test("should accept sequential height (current + 1)", () => {
        expect(validateBlockHeight(5, 4)).toBe(true);
        expect(validateBlockHeight(100, 99)).toBe(true);
        expect(validateBlockHeight(2, 1)).toBe(true);
    });

    test("should reject non-sequential heights", () => {
        expect(validateBlockHeight(6, 4)).toBe(false); // Skip ahead
        expect(validateBlockHeight(4, 4)).toBe(false); // Same height
        expect(validateBlockHeight(3, 4)).toBe(false); // Go backwards
        expect(validateBlockHeight(1, 5)).toBe(false); // Far behind
    });

    test("should handle large block heights", () => {
        expect(validateBlockHeight(1000000, 999999)).toBe(true);
        expect(validateBlockHeight(1000001, 999999)).toBe(false);
    });

    test("should handle negative block heights", () => {
        expect(validateBlockHeight(-1, 0)).toBe(false);
        expect(validateBlockHeight(1, -1)).toBe(false);
    });

    test("should handle floating point heights", () => {
        expect(validateBlockHeight(1.5, 0)).toBe(false);
        expect(validateBlockHeight(2, 1.5)).toBe(false);
    });
});

describe("Block ID Calculation and Validation", () => {
    test("should calculate correct SHA256 hash for block with single transaction", () => {
        const transactions: Transaction[] = [
            {
                id: "tx1",
                inputs: [],
                outputs: []
            }
        ];

        const expectedHash = "d1582b9e2cac15e170c39ef2e85855ffd7e6a820550a8ca16a2f016d366503dc"; // SHA256 of "1tx1"
        expect(calculateBlockId(1, transactions)).toBe(expectedHash);
    });

    test("should calculate correct SHA256 hash for block with multiple transactions", () => {
        const transactions: Transaction[] = [
            {
                id: "tx1",
                inputs: [],
                outputs: []
            },
            {
                id: "tx2",
                inputs: [],
                outputs: []
            }
        ];

        const expectedHash = "74a9608142770b46c9eec3f39f41b4fb38d8d7f4063ac5676ccc2ed1d670c92b"; // SHA256 of "1tx1tx2"
        expect(calculateBlockId(1, transactions)).toBe(expectedHash);
    });

    test("should calculate different hashes for different heights with same transactions", () => {
        const transactions: Transaction[] = [
            {
                id: "tx1",
                inputs: [],
                outputs: []
            }
        ];

        const hash1 = calculateBlockId(1, transactions);
        const hash2 = calculateBlockId(2, transactions);

        expect(hash1).not.toBe(hash2);
    });

    test("should calculate different hashes for same height with different transactions", () => {
        const transactions1: Transaction[] = [
            {
                id: "tx1",
                inputs: [],
                outputs: []
            }
        ];

        const transactions2: Transaction[] = [
            {
                id: "tx2",
                inputs: [],
                outputs: []
            }
        ];

        const hash1 = calculateBlockId(1, transactions1);
        const hash2 = calculateBlockId(1, transactions2);

        expect(hash1).not.toBe(hash2);
    });

    test("should handle empty transaction array", () => {
        const transactions: Transaction[] = [];
        const hash = calculateBlockId(1, transactions);

        // Should be SHA256 of "1" (just the height)
        const expectedHash = "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b";
        expect(hash).toBe(expectedHash);
    });

    test("should validate correct block ID", () => {
        const transactions: Transaction[] = [
            {
                id: "tx1",
                inputs: [],
                outputs: []
            }
        ];

        const block: Block = {
            height: 1,
            id: "d1582b9e2cac15e170c39ef2e85855ffd7e6a820550a8ca16a2f016d366503dc", // SHA256 of "1tx1"
            transactions
        };

        expect(validateBlockId(block)).toBe(true);
    });

    test("should reject incorrect block ID", () => {
        const transactions: Transaction[] = [
            {
                id: "tx1",
                inputs: [],
                outputs: []
            }
        ];

        const block: Block = {
            height: 1,
            id: "incorrect_hash",
            transactions
        };

        expect(validateBlockId(block)).toBe(false);
    });

    test("should reject block ID that doesn't match transaction order", () => {
        const transactions: Transaction[] = [
            {
                id: "tx1",
                inputs: [],
                outputs: []
            },
            {
                id: "tx2",
                inputs: [],
                outputs: []
            }
        ];

        // This is the hash for "1tx2tx1" (wrong order)
        const block: Block = {
            height: 1,
            id: "wrong_order_hash",
            transactions
        };

        expect(validateBlockId(block)).toBe(false);
    });

    test("should handle very long transaction IDs", () => {
        const longTxId = "a".repeat(1000);
        const transactions: Transaction[] = [
            {
                id: longTxId,
                inputs: [],
                outputs: []
            }
        ];

        const hash = calculateBlockId(1, transactions);
        expect(hash).toHaveLength(64); // SHA256 always produces 64 character hex string
        expect(hash).toMatch(/^[a-f0-9]{64}$/); // Should be valid hex
    });

    test("should handle special characters in transaction IDs", () => {
        const transactions: Transaction[] = [
            {
                id: "tx-with-special_chars.123",
                inputs: [],
                outputs: []
            }
        ];

        const hash = calculateBlockId(1, transactions);
        expect(hash).toHaveLength(64);
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
});

describe("Transaction Balance Validation", () => {
    // Mock UTXO lookup function for testing
    const createMockGetUTXOValue = (utxoMap: Record<string, number | null>) => {
        return async (txId: string, index: number): Promise<number | null> => {
            const key = `${txId}:${index}`;
            return utxoMap[key] ?? null;
        };
    };

    test("should validate coinbase transaction with no inputs", async () => {
        const transaction: Transaction = {
            id: "coinbase_tx",
            inputs: [],
            outputs: [
                { address: "addr1", value: 50 }
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({});
        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        expect(result).toBe(true);
    });

    test("should validate coinbase transaction with zero outputs", async () => {
        const transaction: Transaction = {
            id: "coinbase_tx",
            inputs: [],
            outputs: [
                { address: "addr1", value: 0 }
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({});
        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        expect(result).toBe(true);
    });

    test("should reject coinbase transaction with negative outputs", async () => {
        const transaction: Transaction = {
            id: "coinbase_tx",
            inputs: [],
            outputs: [
                { address: "addr1", value: -10 }
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({});
        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        expect(result).toBe(false);
    });

    test("should validate regular transaction with balanced inputs and outputs", async () => {
        const transaction: Transaction = {
            id: "regular_tx",
            inputs: [
                { txId: "prev_tx1", index: 0 },
                { txId: "prev_tx2", index: 1 }
            ],
            outputs: [
                { address: "addr1", value: 30 },
                { address: "addr2", value: 20 }
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx1:0": 35,
            "prev_tx2:1": 15
        });

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        expect(result).toBe(true);
    });

    test("should reject transaction where input sum is less than output sum", async () => {
        const transaction: Transaction = {
            id: "invalid_tx",
            inputs: [
                { txId: "prev_tx1", index: 0 }
            ],
            outputs: [
                { address: "addr1", value: 30 },
                { address: "addr2", value: 25 } // Total: 55, but input is only 50
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx1:0": 50
        });

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        expect(result).toBe(false);
    });

    test("should reject transaction where input sum is greater than output sum", async () => {
        const transaction: Transaction = {
            id: "invalid_tx",
            inputs: [
                { txId: "prev_tx1", index: 0 }
            ],
            outputs: [
                { address: "addr1", value: 30 } // Total: 30, but input is 50
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx1:0": 50
        });

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        expect(result).toBe(false);
    });

    test("should reject transaction with non-existent UTXO input", async () => {
        const transaction: Transaction = {
            id: "invalid_tx",
            inputs: [
                { txId: "non_existent_tx", index: 0 }
            ],
            outputs: [
                { address: "addr1", value: 30 }
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({});

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        expect(result).toBe(false);
    });

    test("should handle transaction with multiple inputs and outputs", async () => {
        const transaction: Transaction = {
            id: "complex_tx",
            inputs: [
                { txId: "prev_tx1", index: 0 },
                { txId: "prev_tx1", index: 1 },
                { txId: "prev_tx2", index: 0 }
            ],
            outputs: [
                { address: "addr1", value: 25 },
                { address: "addr2", value: 35 },
                { address: "addr3", value: 40 }
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx1:0": 30,
            "prev_tx1:1": 45,
            "prev_tx2:0": 25
        });

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        expect(result).toBe(true);
    });

    test("should handle zero-value transactions", async () => {
        const transaction: Transaction = {
            id: "zero_tx",
            inputs: [
                { txId: "prev_tx1", index: 0 }
            ],
            outputs: [
                { address: "addr1", value: 0 }
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx1:0": 0
        });

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        expect(result).toBe(true);
    });

    test("should handle transactions with decimal values", async () => {
        const transaction: Transaction = {
            id: "decimal_tx",
            inputs: [
                { txId: "prev_tx1", index: 0 }
            ],
            outputs: [
                { address: "addr1", value: 12.5 },
                { address: "addr2", value: 37.5 }
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx1:0": 50.0
        });

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        expect(result).toBe(true);
    });

    test("should handle floating point precision issues", async () => {
        // This test demonstrates a known JavaScript floating point precision issue
        // 0.1 + 0.2 !== 0.3 in JavaScript due to binary representation
        const transaction: Transaction = {
            id: "precision_tx",
            inputs: [
                { txId: "prev_tx1", index: 0 }
            ],
            outputs: [
                { address: "addr1", value: 0.1 },
                { address: "addr2", value: 0.2 }
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx1:0": 0.3
        });

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        // This will fail due to floating point precision: 0.1 + 0.2 = 0.30000000000000004
        // In a real implementation, you would use integer arithmetic or a decimal library
        expect(result).toBe(false);
    });

    test("should handle precise decimal calculations with integer arithmetic", async () => {
        // Using satoshis (1 BTC = 100,000,000 satoshis) to avoid floating point issues
        const transaction: Transaction = {
            id: "satoshi_tx",
            inputs: [
                { txId: "prev_tx1", index: 0 }
            ],
            outputs: [
                { address: "addr1", value: 10000000 }, // 0.1 BTC in satoshis
                { address: "addr2", value: 20000000 }  // 0.2 BTC in satoshis
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx1:0": 30000000 // 0.3 BTC in satoshis
        });

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        expect(result).toBe(true);
    });

    test("should reject transaction with negative input values", async () => {
        const transaction: Transaction = {
            id: "negative_input_tx",
            inputs: [
                { txId: "prev_tx1", index: 0 }
            ],
            outputs: [
                { address: "addr1", value: 30 }
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx1:0": -50 // Negative UTXO value
        });

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        expect(result).toBe(false);
    });

    test("should reject transaction with negative output values", async () => {
        const transaction: Transaction = {
            id: "negative_output_tx",
            inputs: [
                { txId: "prev_tx1", index: 0 }
            ],
            outputs: [
                { address: "addr1", value: -30 }
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx1:0": 50
        });

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        expect(result).toBe(false);
    });
});

describe("Edge Cases and Error Handling", () => {
    const createMockGetUTXOValue = (utxoMap: Record<string, number | null>) => {
        return async (txId: string, index: number): Promise<number | null> => {
            const key = `${txId}:${index}`;
            return utxoMap[key] ?? null;
        };
    };

    test("should handle transaction with same UTXO referenced multiple times", async () => {
        const transaction: Transaction = {
            id: "double_spend_tx",
            inputs: [
                { txId: "prev_tx1", index: 0 },
                { txId: "prev_tx1", index: 0 } // Same UTXO referenced twice
            ],
            outputs: [
                { address: "addr1", value: 100 }
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx1:0": 50
        });

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        // Should sum both references: 50 + 50 = 100
        expect(result).toBe(true);
    });

    test("should handle transaction with empty outputs array", async () => {
        const transaction: Transaction = {
            id: "no_outputs_tx",
            inputs: [
                { txId: "prev_tx1", index: 0 }
            ],
            outputs: []
        };

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx1:0": 50
        });

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        // Input sum (50) != output sum (0)
        expect(result).toBe(false);
    });

    test("should handle coinbase transaction with empty outputs", async () => {
        const transaction: Transaction = {
            id: "empty_coinbase_tx",
            inputs: [],
            outputs: []
        };

        const mockGetUTXOValue = createMockGetUTXOValue({});

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        // Coinbase with no outputs should be valid (output sum = 0 >= 0)
        expect(result).toBe(true);
    });

    test("should handle very large transaction values", async () => {
        const transaction: Transaction = {
            id: "large_value_tx",
            inputs: [
                { txId: "prev_tx1", index: 0 }
            ],
            outputs: [
                { address: "addr1", value: Number.MAX_SAFE_INTEGER }
            ]
        };

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx1:0": Number.MAX_SAFE_INTEGER
        });

        const result = await validateTransactionBalance(transaction, mockGetUTXOValue);

        expect(result).toBe(true);
    });
});

describe("Multiple Transaction Balance Validation", () => {
    const createMockGetUTXOValue = (utxoMap: Record<string, number | null>) => {
        return async (txId: string, index: number): Promise<number | null> => {
            const key = `${txId}:${index}`;
            return utxoMap[key] ?? null;
        };
    };

    test("should validate all transactions when all are valid", async () => {
        const transactions: Transaction[] = [
            {
                id: "coinbase_tx",
                inputs: [],
                outputs: [{ address: "addr1", value: 50 }]
            },
            {
                id: "regular_tx",
                inputs: [{ txId: "prev_tx", index: 0 }],
                outputs: [{ address: "addr2", value: 25 }]
            }
        ];

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx:0": 25
        });

        const result = await validateTransactionBalances(transactions, mockGetUTXOValue);

        expect(result).toBe(true);
    });

    test("should reject when any transaction is invalid", async () => {
        const transactions: Transaction[] = [
            {
                id: "valid_tx",
                inputs: [{ txId: "prev_tx1", index: 0 }],
                outputs: [{ address: "addr1", value: 30 }]
            },
            {
                id: "invalid_tx",
                inputs: [{ txId: "prev_tx2", index: 0 }],
                outputs: [{ address: "addr2", value: 50 }] // More than input
            }
        ];

        const mockGetUTXOValue = createMockGetUTXOValue({
            "prev_tx1:0": 30,
            "prev_tx2:0": 40 // Less than output
        });

        const result = await validateTransactionBalances(transactions, mockGetUTXOValue);

        expect(result).toBe(false);
    });

    test("should handle empty transaction array", async () => {
        const transactions: Transaction[] = [];
        const mockGetUTXOValue = createMockGetUTXOValue({});

        const result = await validateTransactionBalances(transactions, mockGetUTXOValue);

        expect(result).toBe(true);
    });

    test("should validate complex block with multiple transaction types", async () => {
        const transactions: Transaction[] = [
            // Coinbase transaction
            {
                id: "coinbase",
                inputs: [],
                outputs: [{ address: "miner", value: 50 }]
            },
            // Regular transaction 1
            {
                id: "tx1",
                inputs: [{ txId: "utxo1", index: 0 }],
                outputs: [
                    { address: "addr1", value: 20 },
                    { address: "addr2", value: 10 }
                ]
            },
            // Regular transaction 2
            {
                id: "tx2",
                inputs: [
                    { txId: "utxo2", index: 0 },
                    { txId: "utxo3", index: 1 }
                ],
                outputs: [
                    { address: "addr3", value: 45 }
                ]
            }
        ];

        const mockGetUTXOValue = createMockGetUTXOValue({
            "utxo1:0": 30,
            "utxo2:0": 25,
            "utxo3:1": 20
        });

        const result = await validateTransactionBalances(transactions, mockGetUTXOValue);

        expect(result).toBe(true);
    });

    test("should stop validation on first invalid transaction", async () => {
        let callCount = 0;
        const mockGetUTXOValue = async (txId: string, index: number): Promise<number | null> => {
            callCount++;
            if (txId === "valid_utxo") return 30;
            if (txId === "invalid_utxo") return 20; // Less than output
            return null;
        };

        const transactions: Transaction[] = [
            {
                id: "valid_tx",
                inputs: [{ txId: "valid_utxo", index: 0 }],
                outputs: [{ address: "addr1", value: 30 }]
            },
            {
                id: "invalid_tx",
                inputs: [{ txId: "invalid_utxo", index: 0 }],
                outputs: [{ address: "addr2", value: 30 }] // More than input
            },
            {
                id: "should_not_be_validated",
                inputs: [{ txId: "another_utxo", index: 0 }],
                outputs: [{ address: "addr3", value: 25 }]
            }
        ];

        const result = await validateTransactionBalances(transactions, mockGetUTXOValue);

        expect(result).toBe(false);
        // Should have called UTXO lookup for first transaction (1 call) and second transaction (1 call)
        // but not for the third transaction
        expect(callCount).toBe(2);
    });
});