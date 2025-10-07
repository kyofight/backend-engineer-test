import { DatabaseConnection } from '@database/connection';
import { DatabaseManager } from '@services/database-manager';
import { BlockProcessor } from '@services/block-processor';
import { UTXORepository } from '@database/repositories/utxo-repository';
import { BalanceRepository } from '@database/repositories/balance-repository';

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