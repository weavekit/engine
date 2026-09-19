import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';

/**
 * Operational routes, registered unconditionally (independent of any adapter
 * toggle) so the deployment can always probe the process:
 *
 * - `GET /health` — liveness: the process is up (never touches the database).
 * - `GET /ready`  — readiness: the engine can serve traffic (checks PostgreSQL).
 * - `GET /version` — build identity for troubleshooting / compatibility checks.
 */

export interface OpsDeps {
  pool: Pool;
  version: string;
}

export interface OpsResult {
  status: 'ok' | 'error';
  db?: 'up' | 'down';
}

export function registerOpsRoutes(app: FastifyInstance, deps: OpsDeps): void {
  const { pool, version } = deps;

  app.get('/health', async () => {
    return { status: 'ok' } satisfies OpsResult;
  });

  app.get('/ready', async (_request, reply: FastifyReply): Promise<OpsResult> => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', db: 'up' };
    } catch {
      reply.status(503);
      return { status: 'error', db: 'down' };
    }
  });

  app.get('/version', async () => {
    return { name: 'weavekit', version };
  });
}
