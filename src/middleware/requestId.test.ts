import { describe, it, expect, vi } from 'vitest';
import { requestIdHook, loggerForJob } from './requestId.js';

describe('requestIdHook', () => {
  it('generates a UUID when no header is present', async () => {
    const req: any = { headers: {} };
    const reply: any = { header: vi.fn() };
    let called = false;
    await requestIdHook(req, reply, () => { called = true; });
    expect(called).toBe(true);
    expect(req.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(reply.header).toHaveBeenCalledWith('X-Request-Id', req.id);
  });

  it('honors an incoming X-Request-Id header', async () => {
    const req: any = { headers: { 'x-request-id': 'caller-supplied-123' } };
    const reply: any = { header: vi.fn() };
    await requestIdHook(req, reply, () => {});
    expect(req.id).toBe('caller-supplied-123');
    expect(reply.header).toHaveBeenCalledWith('X-Request-Id', 'caller-supplied-123');
  });

  it('rejects suspicious non-string header values', async () => {
    const req: any = { headers: { 'x-request-id': ['malicious', 'array'] } };
    const reply: any = { header: vi.fn() };
    await requestIdHook(req, reply, () => {});
    expect(req.id).toMatch(/^[0-9a-f]{8}-/);
  });

  it('rejects header values with unsafe characters', async () => {
    const req: any = { headers: { 'x-request-id': 'has\nnewline' } };
    const reply: any = { header: vi.fn() };
    await requestIdHook(req, reply, () => {});
    expect(req.id).toMatch(/^[0-9a-f]{8}-/);
  });
});

describe('loggerForJob', () => {
  it('returns a child logger carrying reqId + jobId + queueName', () => {
    const logger = loggerForJob(
      { id: 'job-1', data: { reqId: 'r-1' } } as any,
      { name: 'audio.transcribe' },
    );
    expect(logger.bindings()).toMatchObject({
      reqId: 'r-1',
      jobId: 'job-1',
      queueName: 'audio.transcribe',
    });
  });

  it('falls back to a generated UUID when reqId is missing', () => {
    const logger = loggerForJob(
      { id: 'job-2', data: {} } as any,
      { name: 'conversation.process' },
    );
    expect(logger.bindings().reqId).toMatch(/^[0-9a-f]{8}-/);
  });
});