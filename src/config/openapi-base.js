// Base OpenAPI specification for generation script
// This is a simplified version used by the generation script

export const baseOpenApiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Blockchain Indexer API',
    description: 'A blockchain indexer service that processes blocks, manages balances, and provides rollback functionality',
    version: '1.0.0',
    contact: {
      name: 'API Support',
      email: 'support@blockchain-indexer.com'
    },
    license: {
      name: 'MIT',
      url: 'https://opensource.org/licenses/MIT'
    }
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Development server'
    }
  ],
  tags: [
    {
      name: 'Health',
      description: 'Health check and monitoring endpoints'
    },
    {
      name: 'Blocks',
      description: 'Block processing operations'
    },
    {
      name: 'Balance',
      description: 'Address balance queries'
    },
    {
      name: 'Rollback',
      description: 'Blockchain state rollback operations'
    }
  ]
};