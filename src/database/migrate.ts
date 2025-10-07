import { DatabaseConnection, getDatabaseConfigFromEnv, createDatabaseConfig } from '@database/index.js';

async function runMigrations() {
  try {
    const config = getDatabaseConfigFromEnv();
    const dbConfig = createDatabaseConfig(config);
    const db = DatabaseConnection.getInstance(dbConfig);

    console.log('Running database migrations...');
    
    // Read and execute the migration SQL
    const migrationSql = `
-- Create blocks table
CREATE TABLE IF NOT EXISTS blocks (
  height INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  transaction_count INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create transactions table
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  block_height INTEGER NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
  transaction_index INTEGER NOT NULL
);

-- Create transaction_inputs table
CREATE TABLE IF NOT EXISTS transaction_inputs (
  id SERIAL PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  utxo_tx_id TEXT NOT NULL,
  utxo_index INTEGER NOT NULL,
  input_index INTEGER NOT NULL
);

-- Create transaction_outputs table (UTXO tracking)
CREATE TABLE IF NOT EXISTS transaction_outputs (
  id SERIAL PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  output_index INTEGER NOT NULL,
  address TEXT NOT NULL,
  value DECIMAL(20,8) NOT NULL,
  is_spent BOOLEAN DEFAULT FALSE,
  spent_by_tx_id TEXT,
  spent_at_height INTEGER
);

-- Create balances table
CREATE TABLE IF NOT EXISTS balances (
  address TEXT PRIMARY KEY,
  balance DECIMAL(20,8) NOT NULL DEFAULT 0,
  last_updated_height INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_transactions_block_height ON transactions(block_height);
CREATE INDEX IF NOT EXISTS idx_transaction_inputs_utxo ON transaction_inputs(utxo_tx_id, utxo_index);
CREATE INDEX IF NOT EXISTS idx_transaction_outputs_address ON transaction_outputs(address);
CREATE INDEX IF NOT EXISTS idx_transaction_outputs_spent ON transaction_outputs(is_spent);
CREATE INDEX IF NOT EXISTS idx_balances_address ON balances(address);
    `;

    await db.query(migrationSql);
    console.log('Database migrations completed successfully');
  } catch (error) {
    console.error('Failed to run migrations:', error);
    throw error;
  }
}

// Export for use in other modules

export { runMigrations };