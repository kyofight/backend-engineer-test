// Core blockchain data models

export interface Block {
  height: number;
  id: string;
  transactions: Transaction[];
}

export interface Transaction {
  id: string;
  inputs: Input[];
  outputs: Output[];
}

export interface Input {
  txId: string;
  index: number;
}

export interface Output {
  address: string;
  value: number;
}

export interface Balance {
  address: string;
  balance: number;
  lastUpdatedHeight: number;
}

// Database entity interfaces
export interface BlockEntity {
  height: number;
  id: string;
  transaction_count: number;
  created_at: Date;
}

export interface TransactionEntity {
  id: string;
  block_height: number;
  transaction_index: number;
}

export interface TransactionInputEntity {
  id: number;
  transaction_id: string;
  utxo_tx_id: string;
  utxo_index: number;
  input_index: number;
}

export interface TransactionOutputEntity {
  id: number;
  transaction_id: string;
  output_index: number;
  address: string;
  value: string; // DECIMAL stored as string
  is_spent: boolean;
  spent_by_tx_id: string | null;
  spent_at_height: number | null;
}

export interface BalanceEntity {
  address: string;
  balance: string; // DECIMAL stored as string
  last_updated_height: number;
  updated_at: Date;
}

// Processing result types
export interface ProcessingResult {
  success: boolean;
  blockHeight: number;
  message?: string;
  error?: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export interface RollbackResult {
  success: boolean;
  newHeight: number;
  message?: string;
  error?: string;
}

// Balance update batch operation
export interface BalanceUpdate {
  address: string;
  amount: number;
}

// UTXO (Unspent Transaction Output) interface
export interface UTXO {
  txId: string;
  index: number;
  address: string;
  value: number;
  isSpent: boolean;
  spentByTxId?: string;
  spentAtHeight?: number;
}