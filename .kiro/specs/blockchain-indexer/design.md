# Design Document

## Overview

The blockchain indexer is designed as a RESTful API service built on Fastify and PostgreSQL that maintains real-time address balance tracking. The system processes blockchain data sequentially to ensure consistency, provides fast balance queries, and supports rollback operations for handling blockchain reorganizations.

## Architecture

The indexer follows a layered architecture pattern:

```
┌─────────────────────────────────────┐
│           API Layer                 │
│  (Fastify Routes & Validation)      │
├─────────────────────────────────────┤
│         Service Layer               │
│  (Business Logic & Orchestration)   │
├─────────────────────────────────────┤
│        Repository Layer             │
│   (Data Access & Transactions)      │
├─────────────────────────────────────┤
│         Database Layer              │
│      (PostgreSQL Storage)           │
└─────────────────────────────────────┘
```

### Key Design Principles

1. **Sequential Processing**: Blocks are processed in order to maintain consistency
2. **Transactional Integrity**: All balance updates within a block are atomic
3. **Concurrent Read Safety**: Balance queries can run safely during block processing
4. **Rollback Support**: Complete state restoration to any previous block height

## Components and Interfaces

### API Routes

#### POST /blocks
- **Purpose**: Accept and process new blockchain blocks
- **Input**: Block data with height, transactions, and metadata
- **Output**: Processing confirmation with block height
- **Validation**: 
  1. Height must be exactly one unit higher than current height (first block must be height 1)
  2. Sum of input values must equal sum of output values for each transaction
  3. Block ID must be SHA256 hash of (height + transaction1.id + transaction2.id + ... + transactionN.id)
  4. All validation failures return 400 status with appropriate error messages

#### GET /balance/:address
- **Purpose**: Retrieve current balance for a specific address
- **Input**: Blockchain address as URL parameter
- **Output**: Current balance amount
- **Caching**: Read-optimized with potential for future caching layer

#### POST /rollback
- **Purpose**: Revert indexer state to a specific block height by undoing all transactions after that height and recalculating balances
- **Input**: Target height as query parameter (limited to within 2000 blocks of current height)
- **Output**: Confirmation of rollback completion with new current height
- **Process**: Removes all blocks/transactions after target height, unspends UTXOs, and recalculates all address balances
- **Safety**: Validates target height is within 2000 blocks and maintains data integrity

### Service Layer

#### BlockProcessor
```typescript
interface BlockProcessor {
  processBlock(block: Block): Promise<ProcessingResult>;
  validateBlock(block: Block): ValidationResult;
  validateBlockHeight(height: number): boolean;
  validateBlockId(block: Block): boolean;
  validateTransactionBalances(transactions: Transaction[]): boolean;
  rollbackToHeight(height: number): Promise<RollbackResult>;
}
```

#### BalanceService
```typescript
interface BalanceService {
  getBalance(address: string): Promise<number>;
  processUTXOTransactions(transactions: Transaction[]): Promise<void>;
  rollbackBalances(toHeight: number): Promise<void>;
}
```

#### UTXOService
```typescript
interface UTXOService {
  spendUTXOs(inputs: Input[]): Promise<void>;
  createUTXOs(outputs: Output[], txId: string): Promise<void>;
  validateInputs(inputs: Input[]): Promise<boolean>;
}
```

### Repository Layer

#### BlockRepository
```typescript
interface BlockRepository {
  saveBlock(block: Block): Promise<void>;
  getLastBlockHeight(): Promise<number>;
  deleteBlocksAfterHeight(height: number): Promise<void>;
}
```

#### BalanceRepository
```typescript
interface BalanceRepository {
  getBalance(address: string): Promise<number>;
  updateBalance(address: string, amount: number): Promise<void>;
  batchUpdateBalances(updates: BalanceUpdate[]): Promise<void>;
  rollbackToHeight(height: number): Promise<void>;
}
```

#### UTXORepository
```typescript
interface UTXORepository {
  saveUTXOs(outputs: Output[], txId: string, blockHeight: number): Promise<void>;
  spendUTXOs(inputs: Input[], spentByTxId: string, blockHeight: number): Promise<void>;
  getUTXO(txId: string, index: number): Promise<UTXO | null>;
  getUnspentUTXOsForAddress(address: string): Promise<UTXO[]>;
  rollbackUTXOsAfterHeight(height: number): Promise<void>;
  recalculateAllBalances(): Promise<void>;
}
```

## Data Models

### Database Schema

#### blocks table
```sql
CREATE TABLE blocks (
  height INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  transaction_count INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

#### transactions table
```sql
CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  block_height INTEGER NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
  transaction_index INTEGER NOT NULL
);
```

#### transaction_inputs table
```sql
CREATE TABLE transaction_inputs (
  id SERIAL PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  utxo_tx_id TEXT NOT NULL,
  utxo_index INTEGER NOT NULL,
  input_index INTEGER NOT NULL
);
```

#### transaction_outputs table
```sql
CREATE TABLE transaction_outputs (
  id SERIAL PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  output_index INTEGER NOT NULL,
  address TEXT NOT NULL,
  value DECIMAL(20,8) NOT NULL,
  is_spent BOOLEAN DEFAULT FALSE,
  spent_by_tx_id TEXT,
  spent_at_height INTEGER
);
```

#### balances table
```sql
CREATE TABLE balances (
  address TEXT PRIMARY KEY,
  balance DECIMAL(20,8) NOT NULL DEFAULT 0,
  last_updated_height INTEGER NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);
```

#### balance_history table (for rollback support)
```sql
CREATE TABLE balance_history (
  id SERIAL PRIMARY KEY,
  address TEXT NOT NULL,
  balance DECIMAL(20,8) NOT NULL,
  block_height INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_address_height (address, block_height)
);
```

### TypeScript Interfaces

```typescript
interface Block {
  height: number;
  id: string;
  transactions: Transaction[];
}

interface Transaction {
  id: string;
  inputs: Input[];
  outputs: Output[];
}

interface Output {
  address: string;
  value: number;
}

interface Input {
  txId: string;
  index: number;
}

interface Balance {
  address: string;
  balance: number;
  lastUpdatedHeight: number;
}
```

## Error Handling

### Error Categories

1. **Validation Errors (400)**
   - Invalid block format
   - Non-sequential block height (must be exactly current height + 1)
   - Invalid block ID (must be SHA256 of height + concatenated transaction IDs)
   - Transaction input/output value mismatch (sum of inputs ≠ sum of outputs)
   - Invalid address format
   - Invalid transaction amounts

2. **Conflict Errors (409)**
   - Block already processed
   - Rollback target height invalid (more than 2000 blocks from current height)

3. **Server Errors (500)**
   - Database connection failures
   - Transaction rollback failures
   - Concurrent processing conflicts

### Error Response Format
```typescript
interface ErrorResponse {
  error: string;
  message: string;
  details?: any;
  timestamp: string;
}
```

### Recovery Strategies

- **Database Failures**: Automatic transaction rollback with retry logic
- **Validation Failures**: Detailed error messages for client correction
- **Concurrency Issues**: Request queuing and sequential processing
- **Rollback Failures**: State verification and manual intervention alerts

## Testing Strategy

### Unit Testing
- Service layer business logic validation
- Repository layer data access patterns
- Utility functions for validation and formatting

### Integration Testing
- API endpoint functionality with real database
- Block processing workflows end-to-end
- Rollback operations with state verification
- Concurrent request handling

### Performance Testing
- Balance query response times under load
- Block processing throughput limits
- Database connection pool optimization
- Memory usage during large rollbacks

### Test Data Management
- Deterministic test blockchain data
- Database seeding and cleanup utilities
- Mock external dependencies
- Rollback scenario test cases