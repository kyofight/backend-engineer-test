import type { Block, Transaction, ValidationResult } from '../types/index.js';
import { createHash } from 'crypto';

/**
 * Validates that the block height is sequential (current + 1) or is the first block (height = 1)
 * @param blockHeight - The height of the block being validated
 * @param currentHeight - The current highest block height in the system (0 if no blocks exist)
 * @returns true if the block height is valid, false otherwise
 */
export function validateBlockHeight(blockHeight: number, currentHeight: number): boolean {
  // Handle first block case (height = 1 when no blocks exist)
  if (currentHeight === 0) {
    return blockHeight === 1;
  }

  // For subsequent blocks, height must be exactly current + 1
  return blockHeight === currentHeight + 1;
}

/**
 * Calculates the expected block ID by concatenating height + transaction IDs and hashing with SHA256
 * @param height - The block height
 * @param transactions - Array of transactions in the block
 * @returns The calculated SHA256 hash as a hex string
 */
export function calculateBlockId(height: number, transactions: Transaction[]): string {
  // Concatenate height with all transaction IDs
  const concatenated = height.toString() + transactions.map(tx => tx.id).join('');

  // Calculate SHA256 hash
  return createHash('sha256').update(concatenated).digest('hex');
}

/**
 * Validates that the block ID matches the expected SHA256 hash of height + transaction IDs
 * @param block - The block to validate
 * @returns true if the block ID is valid, false otherwise
 */
export function validateBlockId(block: Block): boolean {
  const expectedId = calculateBlockId(block.height, block.transactions);
  return block.id === expectedId;
}

/**
 * Validates that the sum of input values equals the sum of output values for a transaction
 * Note: For the first transaction in a block (coinbase), inputs may be empty, so we skip validation
 * @param transaction - The transaction to validate
 * @param getUTXOValue - Function to get the value of a UTXO by txId and index
 * @returns Promise<boolean> - true if transaction balances are valid, false otherwise
 */
export async function validateTransactionBalance(
  transaction: Transaction,
  getUTXOValue: (txId: string, index: number) => Promise<number | null>
): Promise<boolean> {
  // Calculate sum of input values
  let inputSum = 0;
  for (const input of transaction.inputs) {
    const utxoValue = await getUTXOValue(input.txId, input.index);
    if (utxoValue === null) {
      // UTXO not found - invalid input
      return false;
    }
    inputSum += utxoValue;
  }

  // Calculate sum of output values
  const outputSum = transaction.outputs.reduce((sum, output) => sum + output.value, 0);

  // For coinbase transactions (first transaction in block), inputs can be empty
  // In this case, we only validate that outputs are positive
  if (transaction.inputs.length === 0) {
    return outputSum >= 0;
  }

  // For regular transactions, input sum must equal output sum
  return inputSum === outputSum;
}

/**
 * Validates transaction balances for all transactions in an array
 * @param transactions - Array of transactions to validate
 * @param getUTXOValue - Function to get the value of a UTXO by txId and index
 * @returns Promise<boolean> - true if all transaction balances are valid, false otherwise
 */
export async function validateTransactionBalances(
  transactions: Transaction[],
  getUTXOValue: (txId: string, index: number) => Promise<number | null>
): Promise<boolean> {
  for (const transaction of transactions) {
    const isValid = await validateTransactionBalance(transaction, getUTXOValue);
    if (!isValid) {
      return false;
    }
  }
  return true;
}