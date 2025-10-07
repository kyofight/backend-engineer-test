# Implementation Plan

- [x] 1. Set up database schema and core interfaces

  - Create database migration scripts for blocks, transactions, inputs, outputs, and balances tables
  - Define TypeScript interfaces for Block, Transaction, Input, Output, and Balance models
  - Set up database connection utilities and transaction management
  - _Requirements: 1.1, 1.2, 2.1, 3.1, 4.4, 5.1_

- [x] 2. Implement core validation utilities

  - [x] 2.1 Create block height validation logic

    - Implement function to validate sequential block height (current + 1)
    - Handle first block case (height = 1)
    - _Requirements: 5.2_

  - [x] 2.2 Create block ID validation using SHA256

    - Implement SHA256 hash calculation for block ID verification
    - Create function to concatenate height + transaction IDs and hash
    - _Requirements: 5.1_

  - [x] 2.3 Create transaction balance validation

    - Implement input/output sum validation for each transaction
    - Ensure sum of input values equals sum of output values
    - _Requirements: 5.3_

  - [x] 2.4 Write unit tests for validation utilities
    - Test block height validation edge cases
    - Test block ID hash calculation accuracy
    - Test transaction balance validation scenarios
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 3. Implement UTXO repository layer

  - [x] 3.1 Create UTXO repository with database operations

    - Implement saveUTXOs method for creating new outputs
    - Implement spendUTXOs method for marking inputs as spent
    - Implement getUTXO method for retrieving specific UTXO
    - _Requirements: 1.1, 1.2_

  - [x] 3.2 Implement UTXO rollback functionality

    - Create rollbackUTXOsAfterHeight method to undo transactions
    - Implement logic to unspend UTXOs and remove outputs after target height
    - _Requirements: 3.1, 3.3_

  - [x] 3.3 Write unit tests for UTXO repository
    - Test UTXO creation and spending operations
    - Test rollback functionality with various scenarios
    - _Requirements: 1.1, 1.2, 3.1_

- [x] 4. Implement balance calculation and management

  - [x] 4.1 Create balance repository with address balance tracking

    - Implement getBalance method for address balance queries
    - Implement updateBalance and batchUpdateBalances methods
    - _Requirements: 2.1, 2.2_

  - [x] 4.2 Implement balance recalculation from UTXOs

    - Create recalculateAllBalances method that sums unspent UTXOs per address
    - Ensure accurate balance calculation after rollbacks
    - _Requirements: 3.1, 3.4_

  - [x] 4.3 Write unit tests for balance operations
    - Test balance calculation accuracy
    - Test balance updates and batch operations
    - _Requirements: 2.1, 2.2, 3.4_

- [x] 5. Implement block processing service

  - [x] 5.1 Create block processor with validation integration

    - Implement processBlock method that validates and processes blocks atomically
    - Integrate all validation functions (height, ID, transaction balances)
    - Handle transaction processing with UTXO creation and spending
    - _Requirements: 1.1, 1.2, 1.3, 5.1, 5.2, 5.3_

  - [x] 5.2 Implement rollback service functionality

    - Create rollbackToHeight method that removes blocks and recalculates balances
    - Validate rollback target is within 2000 blocks of current height
    - Ensure atomic rollback operations with proper error handling
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 5.3 Write integration tests for block processing
    - Test complete block processing workflow
    - Test rollback operations with state verification
    - _Requirements: 1.1, 1.2, 3.1, 3.2_

- [x] 6. Implement REST API endpoints

  - [x] 6.1 Create POST /blocks endpoint

    - Implement route handler with request validation
    - Integrate block processor for processing and validation
    - Return appropriate success/error responses with status codes
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 5.1, 5.2, 5.3, 5.4_

  - [x] 6.2 Create GET /balance/:address endpoint

    - Implement route handler for balance queries
    - Add address format validation
    - Return balance with proper error handling for invalid addresses
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 6.3 Create POST /rollback endpoint

    - Implement route handler with height parameter validation
    - Integrate rollback service with 2000 block limit validation
    - Return rollback confirmation with new current height
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 6.4 Write API integration tests
    - Test all endpoints with various input scenarios
    - Test error handling and status code responses
    - Test concurrent request handling
    - _Requirements: 1.1, 2.1, 3.1, 4.1, 4.2, 4.3_

- [x] 7. Implement concurrency and error handling

  - [x] 7.1 Add request queuing for sequential block processing

    - Implement mutex or queue system for block processing
    - Ensure blocks are processed in sequential order
    - Handle concurrent balance queries safely during processing
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 7.2 Implement comprehensive error handling and recovery

    - Add database transaction rollback on processing failures
    - Implement proper error responses for all validation failures
    - Add logging and monitoring for system health
    - _Requirements: 1.3, 4.4_

  - [x] 7.3 Write concurrency and error handling tests
    - Test concurrent request scenarios
    - Test error recovery and rollback scenarios
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 8. Integration and final testing

  - [x] 8.1 Update main application bootstrap

    - Integrate all services and repositories into main application
    - Set up proper dependency injection and configuration
    - Update database initialization with new schema
    - _Requirements: 1.1, 2.1, 3.1_

  - [x] 8.2 Write end-to-end system tests
    - Test complete workflows from block submission to balance queries
    - Test rollback scenarios with multiple blocks and addresses
    - Test system behavior under various load conditions
    - _Requirements: 1.1, 1.2, 2.1, 3.1, 4.1_
