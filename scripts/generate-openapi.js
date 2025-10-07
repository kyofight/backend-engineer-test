#!/usr/bin/env node

// Script to generate OpenAPI JSON specification
import Fastify from 'fastify';
import { swaggerOptions } from '../src/config/swagger.config.js';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function generateOpenAPISpec() {
  const fastify = Fastify({ logger: false });

  try {
    // Register Swagger
    await fastify.register(import('@fastify/swagger'), swaggerOptions);

    // Add all route schemas (simplified versions for spec generation)
    fastify.get('/', {
      schema: {
        tags: ['Health'],
        summary: 'Service status check',
        description: 'Returns basic service status information',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'ok' },
              service: { type: 'string', example: 'blockchain-indexer' },
              timestamp: { type: 'string', format: 'date-time' }
            }
          }
        }
      }
    }, async () => ({ status: 'ok', service: 'blockchain-indexer', timestamp: new Date().toISOString() }));

    await fastify.ready();

    // Generate the OpenAPI specification
    const spec = fastify.swagger();
    
    // Write to file
    const outputPath = join(__dirname, '..', 'docs', 'openapi.json');
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