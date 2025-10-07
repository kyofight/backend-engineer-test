#!/usr/bin/env node

// Script to generate OpenAPI JSON specification
import Fastify from 'fastify';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { baseOpenApiSpec } from '../src/config/openapi-base.js';
import { schemas } from '../src/config/schemas.js';
import { routeSchemas } from '../src/config/route-schemas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use shared OpenAPI specification for generation
const swaggerOptions = {
  openapi: {
    ...baseOpenApiSpec,
    components: {
      schemas
    }
  }
};

async function generateOpenAPISpec() {
  const fastify = Fastify({ logger: false });

  try {
    // Register Swagger
    await fastify.register(import('@fastify/swagger'), swaggerOptions);

    // Add all route schemas using shared definitions
    
    // Health endpoints
    fastify.get('/', {
      schema: routeSchemas.healthStatus
    }, async () => ({ status: 'ok', service: 'blockchain-indexer', timestamp: new Date().toISOString() }));

    fastify.get('/health', {
      schema: routeSchemas.healthCheck
    }, async () => ({}));

    fastify.get('/metrics', {
      schema: routeSchemas.metrics
    }, async () => ({}));

    // Block processing endpoint
    fastify.post('/blocks', {
      schema: routeSchemas.processBlock
    }, async () => ({}));

    // Balance query endpoint
    fastify.get('/balance/:address', {
      schema: routeSchemas.getBalance
    }, async () => ({}));

    // Rollback endpoint
    fastify.post('/rollback', {
      schema: routeSchemas.rollback
    }, async () => ({}));

    await fastify.ready();

    // Generate the OpenAPI specification
    const spec = fastify.swagger();
    
    // Ensure docs directory exists
    const docsDir = join(__dirname, '..', 'docs');
    mkdirSync(docsDir, { recursive: true });
    
    // Write to file
    const outputPath = join(docsDir, 'openapi.json');
    writeFileSync(outputPath, JSON.stringify(spec, null, 2));
    
    console.log('✅ OpenAPI specification generated successfully!');
    console.log(`📄 Saved to: ${outputPath}`);
    
    await fastify.close();
  } catch (error) {
    console.error('❌ Failed to generate OpenAPI specification:', error.message);
    process.exit(1);
  }
}

generateOpenAPISpec();