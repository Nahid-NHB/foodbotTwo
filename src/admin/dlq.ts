import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audioQueue, processQueue, sendQueue } from '../queue/index.js';
import { logger } from '../logger.js';
import { checkBasicAuth } from './basicAuth.js';

const QUEUE_NAMES = ['audio.transcribe', 'conversation.process', 'whatsapp.send'] as const;

/**
 * `GET /admin/queues/dlq` — list dead-letter jobs across all worker queues.
 *
 * Dead-letter in BullMQ = `failed` jobs whose retry/backoff is exhausted.
 * The DLQ page reads the most recent 50 of each, sorted newest first.
 *
 * Basic auth from ADMIN_BASIC_AUTH_USER / ADMIN_BASIC_AUTH_PASS env vars.
 * Returns 401 on missing/invalid auth, 200 with payload otherwise.
 */
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const a = app as unknown as {
    get: (
      url: string,
      opts: unknown,
      handler: (req: FastifyRequest, reply: {
        code: (n: number) => { send: (b: unknown) => unknown };
        send: (b: unknown) => unknown;
      }) => unknown,
    ) => void;
  };

  a.get('/admin/queues/dlq', {
    schema: {
      tags: ['admin'],
      summary: 'List dead-letter jobs across all worker queues (basic auth)',
      querystring: {
        type: 'object',
        properties: {
          limit: {
            type: 'string',
            description: 'Max jobs per queue (default 50, max 200)',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            queues: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  queue: { type: 'string' },
                  count: { type: 'integer' },
                  jobs: { type: 'array' },
                },
              },
            },
          },
        },
        401: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  }, async (req, reply) => {
    if (!checkBasicAuth(req.headers.authorization)) {
      reply.code(401);
      reply.header('WWW-Authenticate', 'Basic realm="admin"');
      return reply.send({ error: 'unauthorized' });
    }

    const limit = Math.min(parseInt((req.query as Record<string, string | undefined>)['limit'] ?? '50', 10) || 50, 200);
    const perQueue = await Promise.all(
      QUEUE_NAMES.map(async (name) => {
        const queue =
          name === 'audio.transcribe'
            ? audioQueue
            : name === 'conversation.process'
              ? processQueue
              : sendQueue;
        const jobs = await queue.getJobs(['failed'], 0, limit - 1);
        return {
          queue: name,
          count: jobs.length,
          jobs: jobs.map((j) => ({
            id: j.id,
            name: j.name,
            data: j.data,
            failedReason: j.failedReason ?? null,
            attemptsMade: j.attemptsMade,
            timestamp: j.timestamp,
            processedOn: j.processedOn,
            finishedOn: j.finishedOn,
          })),
        };
      }),
    );

    const total = perQueue.reduce((s, q) => s + q.count, 0);
    logger.info({ total, perQueue: perQueue.map((q) => ({ queue: q.queue, count: q.count })) }, 'admin: dlq listed');

    return reply.send({ total, queues: perQueue });
  });
}