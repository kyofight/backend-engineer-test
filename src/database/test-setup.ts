import { DatabaseConnection, createDatabaseConfig, runMigrations } from './index.js';

// Test function to verify database setup
export async function testDatabaseSetup(databaseUrl: string): Promise<boolean> {
  try {
    console.log('Testing database connection...');

    const db = DatabaseConnection.createFromUrl(databaseUrl);

    // Test basic connection
    await db.query('SELECT 1 as test');
    console.log('✓ Database connection successful');

    // Run migrations
    await runMigrations();
    console.log('✓ Database migrations completed');

    // Test that tables were created
    const result = await db.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('blocks', 'transactions', 'transaction_inputs', 'transaction_outputs', 'balances')
      ORDER BY table_name
    `);

    const expectedTables = ['balances', 'blocks', 'transaction_inputs', 'transaction_outputs', 'transactions'];
    const actualTables = result.rows.map((row: any) => row.table_name);

    console.log('Expected tables:', expectedTables);
    console.log('Actual tables:', actualTables);

    const allTablesExist = expectedTables.every(table => actualTables.includes(table));

    if (allTablesExist) {
      console.log('✓ All required tables created successfully');
      return true;
    } else {
      console.error('✗ Some tables are missing');
      return false;
    }

  } catch (error) {
    console.error('✗ Database setup test failed:', error);
    return false;
  }
}