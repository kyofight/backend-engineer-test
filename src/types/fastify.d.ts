import { DatabaseConnection } from '@database/connection.js';
import { DatabaseManager } from '@services/database-manager.js';
import { BlockProcessor } from '@services/block-processor.js';
import { UTXORepository } from '@database/repositories/utxo-repository.js';
import { BalanceRepository } from '@database/repositories/balance-repository.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: any; // May be null if database is not connected
    dbManager: any;
    blockProcessor: any;
    utxoRepository: any;
    balanceRepository: any;
    services?: any;
  }
}