import type { FastifyDynamicSwaggerOptions } from '@fastify/swagger';
import type { FastifySwaggerUiOptions } from '@fastify/swagger-ui';
import { baseOpenApiSpec } from '@config/openapi-base';
import { schemas } from '@config/schemas';

export const swaggerOptions: FastifyDynamicSwaggerOptions = {
  openapi: {
    ...baseOpenApiSpec,
    components: {
      schemas: schemas as any // Type assertion to avoid TypeScript issues with imported JS schemas
    }
  }
};

export const swaggerUiOptions: FastifySwaggerUiOptions = {
  routePrefix: '/docs',
  uiConfig: {
    docExpansion: 'list',
    deepLinking: false
  },
  uiHooks: {
    onRequest: function (request, reply, next) { next(); },
    preHandler: function (request, reply, next) { next(); }
  },
  staticCSP: true,
  transformStaticCSP: (header) => header,
  transformSpecification: (swaggerObject, request, reply) => { return swaggerObject; },
  transformSpecificationClone: true
};