/**
 * OpenAPI / Swagger UI for the Fastify service.
 *
 * Swagger UI:  GET /docs
 * OpenAPI JSON: GET /docs/json
 *
 * Route schemas are registered per-route by the route modules — this
 * file only wires up the plugin. Routes without a schema won't appear
 * in the spec (that's intentional for the webhook, which has a dynamic
 * Meta payload).
 */
import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export async function registerOpenAPI(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Foodbot API',
        version: '0.1.0',
        description: 'Internal HTTP surface for the Phase 1 MVP (webhook, chat, admin).',
      },
      servers: [{ url: 'http://localhost:3000' }],
      tags: [
        { name: 'system', description: 'Liveness, readiness, docs' },
        { name: 'chat', description: 'Internal test-chat UI endpoint' },
        { name: 'admin', description: 'Operator endpoints (basic auth)' },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });
}