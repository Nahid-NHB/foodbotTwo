/**
 * Request-id propagation: HTTP request → BullMQ job → worker logs.
 *
 * Every inbound HTTP request gets a stable id. The webhook router and
 * chatRoute pass it into the queue job's data as `reqId`. Workers pick
 * it up and bind it on a child logger so all log lines for one customer
 * message carry the same correlation id.
 *
 * The header is also echoed on the response so a customer-support ticket
 * ("I sent message X, what happened?") becomes one log query.
 */
import { randomUUID } from 'node:crypto';
import { logger as rootLogger } from '../logger.js';

// Defensive: a malicious header could try to inject newlines or
// log-poisoning patterns. Restrict to a safe charset and length.
const SAFE_HEADER = /^[0-9a-zA-Z._-]{1,128}$/;

export type FastifyOnRequestHook = (
  req: any,
  reply: any,
  next: (err?: Error) => void,
) => Promise<void> | void;

export const requestIdHook: FastifyOnRequestHook = (req, reply, next) => {
  const raw = req.headers?.['x-request-id'];
  const incoming = typeof raw === 'string' ? raw : undefined;
  const id = incoming && SAFE_HEADER.test(incoming) ? incoming : randomUUID();
  req.id = id;
  reply.header('X-Request-Id', id);
  next();
};

/**
 * Build a pino child logger for a BullMQ worker job. Pulls `reqId` from
 * the job data when present; falls back to a fresh UUID.
 */
export function loggerForJob(
  job: { id?: string; data?: { reqId?: string } },
  queue: { name: string },
) {
  const candidate = job.data?.reqId;
  const reqId = candidate && SAFE_HEADER.test(candidate) ? candidate : randomUUID();
  return rootLogger.child({ reqId, jobId: job.id, queueName: queue.name });
}