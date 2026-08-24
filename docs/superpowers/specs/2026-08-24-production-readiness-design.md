# Phase 1 Production-Readiness Polish — Design

**Date:** 2026-08-24
**Status:** Draft (awaiting user review)
**Scope:** Small, scoped hardening of the existing Phase 1 MVP. No new features, no Phase 2.

## 1. Purpose

The MVP works end-to-end (147 tests, real webhook + queue + agent pipeline, deployable via Docker Compose). This document specifies the last batch of polish to take it from "demoable" to "operable": CI, deploy automation, abuse protection, observability, and API documentation. No new product features.

Out of scope: dashboard, TTS, payments, multi-tenant, analytics, metrics scrape, backup automation, HTTPS reverse proxy config.

## 2. Why now

User asked to "complete the whole app". The app is functionally complete — what it needs to feel "shippable" is the boring stuff: CI catches regressions, deploy doesn't need manual intervention, public endpoints can't be DoS'd, and ops can introspect what's running.

## 3. Items in scope

| # | Item | Effort | Risk |
|---|---|---|---|
| 1 | GitHub Actions CI (lint + test with service containers) | S | low |
| 2 | docker-compose: `migrate` service, `app` healthcheck, optional `seed` | S | low |
| 3 | Redis-bucket rate limiting for `POST /webhook` + `POST /api/chat` | M | low |
| 4 | `@fastify/swagger` + `@fastify/swagger-ui` mounted at `/docs` | S | low |
| 5 | Request-id propagation: HTTP request → BullMQ job → worker logs | M | low |
| 6 | `/healthz` reflects worker pool state (liveness of all 3 workers) | S | low |
| 7 | Graceful shutdown ordering: stop accepting HTTP → drain workers → close DB/Redis/queues | S | low |
| 8 | `.dockerignore`, `.gitignore` cleanup (drop `coverage/`, `dist/`, stray `pu/`) | XS | low |
| 9 | README test count fix (123 → 147), production deploy note | XS | none |

## 4. Items explicitly NOT in scope (with rationale)

- **Webhook signature in dev still skippable.** Current behavior: if `NODE_ENV !== 'production'`, the signature check is allowed to be skipped. Tightening this would break the existing test harness and the local `curl` flow documented in the README. Defer.
- **Prometheus / OpenTelemetry.** No consumer, no dashboard. Would add a dependency and config without anywhere to put the data.
- **Backup / restore runbook.** This is a service, not a database. The Postgres data volume (`pgdata`) needs the operator's responsibility — out of scope for app polish.
- **HTTPS reverse proxy config.** Deployment environment concern; Caddyfile/Nginx examples belong in deploy docs, not the app repo.
- **Redis-backed token budget.** `gemini.dailyTokens` is in-memory; restart resets it. Acceptable while the deployment is a single pod. Documented as a known limitation.
- **WebSocket / SSE streaming.** Speculative; not required by any current consumer.

## 5. Item 1 — GitHub Actions CI

**Goal:** every PR runs `npm run lint` and `npm test` against a real Postgres + Redis so regressions are caught pre-merge.

**File:** `.github/workflows/ci.yml`

**Shape:**
- Trigger: `push` (any branch) and `pull_request` to `main`.
- Runner: `ubuntu-latest`, Node 20.
- Steps:
  1. Checkout.
  2. Setup Node 20 with npm cache.
  3. `npm ci`.
  4. `npm run lint`.
  5. Start Postgres 16 + Redis 7 as service containers (matching `docker-compose.yml` defaults: `postgres://foodbot:foodbot@127.0.0.1:5432/foodbot`, `redis://127.0.0.1:6379`).
  6. `npm run migrate`.
  7. `npm run seed`.
  8. `npm test`.

**Why no `docker compose` step:** service containers in GH Actions are first-class and don't require Docker-in-Docker. They're faster and self-contained.

**Why the seed step:** the integration suite needs seeded menu IDs (`data/menu-ids.json`) to run.

## 6. Item 2 — docker-compose: migrate + healthcheck + (optional) seed

**Goal:** `docker compose up` brings up a working app: Postgres migrated, app health-checking green, no manual steps.

**Changes to `docker-compose.yml`:**

- **`app` service**:
  - Add `healthcheck`: `wget -qO- http://127.0.0.1:3000/healthz || exit 1`. (The image already has `wget` via Alpine. If not, fall back to `node -e "fetch(...).then(r => r.ok ? process.exit(0) : process.exit(1))"`. Decision: use the Node one-liner to avoid pulling extra packages.)
  - Add `restart: unless-stopped`.
- **New `migrate` service**: same image, runs `npm run migrate`, exits 0 when done. `depends_on: postgres: service_healthy`. `restart: no`.
- **Optional `seed` service**: profiles `seed`, runs `npm run seed`. Documented in README as `docker compose --profile seed up`.

The `README.md` "Setup" section gets two new paragraphs:
- After step 4: "The `migrate` service runs migrations automatically; the `app` service's healthcheck gates load balancers."
- Under the dev path (step 5): note that `npm run migrate` is no longer required when running through compose.

## 7. Item 3 — Redis-bucket rate limiting

**Goal:** public endpoints can't be hit in volume. Two distinct buckets:
- `POST /webhook` keyed on client IP: 30 req / 60s. (Generous — Meta delivers bursts; 30 RPM leaves 50%+ headroom.)
- `POST /api/chat` keyed on `phone` (E.164 from request body): 20 req / 60s. (A human typing fast tops out at ~120 WPM which is way over 20 RPM; this guards against scripted abuse.)

**Implementation:** new `src/middleware/rateLimit.ts` exporting `createRateLimiter({ keyFn, limit, windowSeconds })` returning a Fastify preHandler hook. Uses Redis INCR + EXPIRE (no sliding window library needed). Returns:
- 200 (hook resolves transparently) when under the limit.
- 429 with `Retry-After: <seconds>` + `{ error: 'rate_limited' }` body otherwise.

**Config knobs (env):**
- `RATELIMIT_WEBHOOK_PER_MIN` (default 30)
- `RATELIMIT_CHAT_PER_MIN` (default 20)
- `RATELIMIT_DISABLED` (default `false`; tests set this to skip)

**Tests:** `src/middleware/rateLimit.test.ts`:
- Under-limit: passes, Redis INCR happens
- Over-limit: 429, `Retry-After` header present
- Different keys don't collide
- Bypassed when `RATELIMIT_DISABLED=true`

**Wire-up:** add the hook in `src/index.ts` after CORS registration, before route registration. Skip in test env via `RATELIMIT_DISABLED=true` set in `vi.hoisted`.

## 8. Item 4 — OpenAPI / Swagger UI

**Goal:** `GET /docs` serves interactive API docs for the Fastify service. No schema writes on every route — minimal route-level annotations.

**Deps:** `@fastify/swagger`, `@fastify/swagger-ui`.

**Spec config:** declare the OpenAPI basics (`info.title`, `info.version`, `info.description`, servers). Routes register their own schemas via Fastify's schema system — only `POST /api/chat`, `GET /readyz`, `GET /admin/queues/dlq` get schemas. Webhook, `GET /healthz`, `GET /docs`, `GET /docs/json` keep no schema.

**Mount:**
- `/docs` → Swagger UI
- `/docs/json` → raw OpenAPI JSON (so CI can dump it, ops can curl it)

**Tests:** `src/openapi.test.ts`:
- `GET /docs` returns 200 HTML
- `GET /docs/json` returns 200 with `openapi: "3.x.x"`
- the chat route, readyz, and DLQ all appear in the spec

## 9. Item 5 — Request-id propagation

**Goal:** every log line about the same customer message carries the same `reqId`, so a complaint becomes a single log query.

**Implementation:**
- New `src/middleware/requestId.ts`:
  - `onRequest` hook reads `x-request-id` if present, otherwise generates a UUID. Stores it on `req.id` and adds it to every log via Fastify's logger bindings (or, simpler: `pino` child logger on the request).
  - Exports a `setJobLogger(job, baseFields)` helper that creates a child logger with `{ reqId, jobId }` for workers to use.
- For the webhook → audio.transcribe enqueue: pass `reqId` in the job data (`reqId?: string`) so the audio worker can pick it up.
- For the audio.transcribe → conversation.process enqueue (the fallback path too): same.

**Tests:** `src/middleware/requestId.test.ts`:
- Generates UUID when no header
- Honors `X-Request-Id` header
- Echoes back in response header
- Propagates through BullMQ job data (assert the worker receives it)

**Wire-up:** in `src/index.ts` before route registration; `src/webhook/router.ts` and `src/queue/index.ts` updated to thread the id.

## 10. Item 6 — /healthz reflects worker pool state

**Goal:** k8s/ECS readiness probes fail when a worker is wedged, so traffic gets steered elsewhere.

Currently `/healthz` always returns `{ ok: true }`. Becomes:
- 200 when API is up AND all three workers are alive (last `worker heartbeat` < 30s ago).
- 503 otherwise, with detail.

**Mechanism:** workers post a heartbeat to Redis (`foodbot:worker:<name>:heartbeat` with 30s TTL) every 10s. `/healthz` reads those keys. Add `src/middleware/workerHeartbeat.ts`:
- `startWorkerHeartbeat(name)` — sets a 10s-interval timer that refreshes the key.
- `readWorkerHeartbeats()` — used by `/healthz`.

**Wire-up:** `createWorkers()` in `src/queue/index.ts` starts the heartbeat for each worker; clears them on `close()`.

**Tests:** `src/middleware/workerHeartbeat.test.ts`:
- Heartbeat writes key + TTL.
- `/healthz` returns 200 with all three alive.
- `/healthz` returns 503 when one is missing.

## 11. Item 7 — Graceful shutdown ordering

**Goal:** on SIGTERM: stop accepting new HTTP, drain in-flight jobs, close DB/Redis. Currently the order is `workers.close() → app.close() → closeDb() → closeRedis()` but `closeDb` and `workers.close()` happen in parallel with `app.close()` (Promise.all is implicit because workers.close and the other closes are sequential statements, but the await chain resolves only the first two before exiting).

**Current code (`src/index.ts`):**
```ts
await workers.close();
await app.close();
const { closeDb } = await import('./db/client.js');
...
```

**Desired order:**
1. `app.close()` — stop accepting new HTTP, finish in-flight requests (Fastify does this on close).
2. Workers continue processing jobs already in their active pool until their current jobs finish + drain BullMQ's stalled-job reaper.
3. `workers.close()` (drain + close).
4. `closeQueues()`.
5. `closeRedis()`.
6. `closeDb()`.

**Implementation:** Add a `totalTimeoutMs` (default 25s) so we don't hang forever — k8s sends SIGKILL after 30s grace. If shutdown doesn't complete in time, log and `process.exit(1)`.

**Tests:** skipped (shutdown timing is hard to test reliably). Document the contract in a comment.

## 12. Item 8 — `.dockerignore` + `.gitignore` cleanup

**.dockerignore (new file):**
```
node_modules
coverage
dist
.git
.github
.vscode
.env
*.log
web/node_modules
web/.next
tests
```

**`.gitignore` verification:**
- Current `.gitignore` at repo root already excludes `coverage/`, `dist/`, `node_modules/`, `.env`, `*.log`. No new entries needed.
- The empty stray `web/pu/` directory observed in the working tree is either deleted or added to `.gitignore` if it's intentional (presumed accidental; delete if empty and unowned).

## 13. Item 9 — README test count + prod deploy note

**README changes:**
- Replace "123 tests across 18 files" with "147 tests across 21 files".
- Under "Architecture", add a one-paragraph "Deploy" subsection: "Production: `docker compose --profile prod up` (or equivalent). The `migrate` service runs idempotently before the `app` service starts; the `app` healthcheck gates load balancers. Set `ADMIN_BASIC_AUTH_PASS` to a strong secret in production."
- Update the env-file example to flag `ADMIN_BASIC_AUTH_PASS` as "MUST override in prod" with a `STRONG_SECRET_HERE` placeholder.

## 14. File-by-file change list

| Path | Change |
|---|---|
| `.github/workflows/ci.yml` | new — CI workflow |
| `docker-compose.yml` | edit — add `migrate` service, `app` healthcheck, `seed` profile |
| `package.json` | edit — add `@fastify/swagger`, `@fastify/swagger-ui` deps |
| `src/config.ts` | edit — add `RATELIMIT_*` env vars |
| `src/env.d.ts` or `src/config.ts` types | add the new env types |
| `.env.example` | edit — add the new env vars + prod warnings |
| `src/middleware/rateLimit.ts` | new — Redis bucket impl |
| `src/middleware/rateLimit.test.ts` | new |
| `src/middleware/requestId.ts` | new — onRequest hook + worker helper |
| `src/middleware/requestId.test.ts` | new |
| `src/middleware/workerHeartbeat.ts` | new — heartbeat writer + reader |
| `src/middleware/workerHeartbeat.test.ts` | new |
| `src/middleware/openapi.ts` | new — registers swagger + UI |
| `src/openapi.test.ts` | new |
| `src/index.ts` | edit — register middlewares, schedule shutdown, fix shutdown order |
| `src/webhook/router.ts` | edit — thread reqId into job data |
| `src/queue/index.ts` | edit — start heartbeat per worker, read reqId from job data, pass to next enqueue |
| `src/web/chatRoute.ts` | edit — thread reqId into outbound job |
| `README.md` | edit — test count, deploy note, env warning |
| `.dockerignore` | new |
| `.gitignore` | edit — verify `dist/`, `coverage/` ignored |

## 15. Migration plan / order of operations

Implementation order — each step leaves tests green before moving on:

1. New deps installed (`@fastify/swagger`, `@fastify/swagger-ui`).
2. Middleware files created with tests (`rateLimit`, `requestId`, `workerHeartbeat`). All three pass.
3. `src/index.ts` registers middlewares; existing 147 tests still pass.
4. `src/webhook/router.ts`, `src/queue/index.ts`, `src/web/chatRoute.ts` thread `reqId`.
5. OpenAPI mounted + routes annotated.
6. CI workflow file added (no local runner; verified by reading it).
7. docker-compose updated; smoke-tested by `docker compose config` (no actual containers — Postgres + Redis already running locally).
8. `.dockerignore` + `.gitignore` cleanup.
9. README updates.
10. Final `npm test` + manual `curl` checks.
11. Commit as 4 logical groups:
    - **chore(deps): add @fastify/swagger + swagger-ui** (one dep commit so future PRs can pin it)
    - **feat(middleware): rate limit, request-id, worker heartbeat**
    - **feat(api): OpenAPI/Swagger UI**
    - **chore(ops): CI workflow + docker-compose migrate + deploy docs**

## 16. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Rate limiter uses Redis unavailable → 500s | On Redis error, the hook resolves (fail-open) with a warn log. Cache/queue already similarly fail-open. |
| Request-id adds QPS overhead | UUID v4 generation + Redis SET is sub-millisecond; negligible. |
| Worker heartbeat setInterval keeps the process alive during shutdown | All heartbeats cleared in `workers.close()`. |
| `@fastify/swagger` mutates route schemas | Use the minimal schema registration pattern; only annotate the routes we want public. Don't retrofit the webhook. |
| CI service containers differ from docker-compose defaults | Match the defaults — same Postgres 16-alpine, same Redis 7-alpine. |

## 17. Success criteria

- `npm test` → 147+ tests, all green, locally and in CI.
- `npm run lint` → 0 errors.
- `docker compose config` validates.
- `curl /docs` → 200 HTML.
- `curl /docs/json` → JSON with `/healthz`, `/readyz`, `/api/chat`, `/admin/queues/dlq`.
- Spamming `curl -X POST /webhook` from one IP 60 times in 60s → 30 succeed, 30 return 429 with `Retry-After`.
- Killing a worker's Redis heartbeat key manually → `/healthz` returns 503 within ~10s.
- SIGTERM with active job → job completes before the process exits.

## 18. Open questions / known follow-ups

- Should `/api/chat` rate-limit IP instead of phone? Phones can be reused; IPs are more stable for abuse. Counter-argument: limiting by phone lets a household on dynamic IPs share a bucket. **Decision: keep phone for `/api/chat`** (test UI is single-user, real customer behavior is per-phone anyway), but add a note for Phase 2 to consider an IP pre-filter.
- Should Webhook bucket key be `X-Forwarded-For` first, then socket IP? **Decision: yes**, trust common private ranges only (RFC 1918). Document the config knob.
- Multi-pod token budget: still in-memory per pod. For Phase 2, move `dailyTokens` to Redis (`INCRBY`). Out of scope for this round; documented as a known limitation.
