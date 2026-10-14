import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { connectTunnel } from '../../runtime/tunnel/index.js';
import { version } from '../../version.js';
import { createPrinter } from '../render.js';

/**
 * `weave expose` — expose a (community/self-hosted) engine through a governance
 * reverse tunnel and report health/version upstream. A thin wrapper over
 * `weave connect` that also sends a **metadata-only** heartbeat
 * (`install_id`/`version`/`hostname`/health) to the governance Console
 * (`POST {heartbeat}/console/heartbeat`). No schema or business data is sent.
 */

export interface ExposeOptions {
  /** governance tunnel endpoint (http/https). */
  endpoint: string;
  /** connections.tunnel_id. */
  tunnel: string;
  /** connections.pairing_token. */
  token: string;
  /** local engine base url. */
  engine: string;
  /** local engine api key (auth to the local engine). */
  apiKey?: string;
  /** console base url for the metadata heartbeat (optional). */
  heartbeat?: string;
  /** heartbeat interval seconds (default 60). */
  interval?: number;
  /** skip TLS certificate verification (dev/self-hosted). */
  insecure?: boolean;
}

export async function expose(_cwd: string, options: ExposeOptions): Promise<void> {
  const printer = createPrinter({ json: false });
  if (!options.apiKey) {
    printer.error('--api-key is required (customer engine auth key)');
    process.exitCode = 1;
    return;
  }

  const installId =
    process.env.WEAVEKIT_INSTALL_ID ?? createHash('sha256').update(`${hostname()}:${options.engine}`).digest('hex').slice(0, 16);

  const handle = connectTunnel({
    endpoint: options.endpoint,
    tunnelId: options.tunnel,
    pairingToken: options.token,
    engineUrl: options.engine,
    engineApiKey: options.apiKey,
    insecure: options.insecure,
  });

  try {
    await handle.ready;
  } catch (error) {
    printer.error(`expose failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    handle.close();
    return;
  }
  printer.log(`exposed: ${options.tunnel} → ${options.engine} (${options.endpoint})`);

  const heartbeatBase = options.heartbeat?.replace(/\/$/, '');
  const beat = async (status: 'online' | 'offline'): Promise<void> => {
    if (heartbeatBase === undefined) return;
    try {
      await fetch(`${heartbeatBase}/console/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tunnel_id: options.tunnel, pairing_token: options.token, install_id: installId, version, hostname: hostname(), status }),
      });
    } catch {
      // heartbeat is best-effort (never blocks the tunnel)
    }
  };

  await beat('online');
  const intervalSec = Math.max(15, options.interval ?? 60);
  const timer = heartbeatBase === undefined ? undefined : setInterval(() => void beat('online'), intervalSec * 1000);

  const shutdown = (): void => {
    if (timer !== undefined) clearInterval(timer);
    void beat('offline').finally(() => {
      handle.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // the open HTTP/2 session keeps the event loop alive; block until signalled
  await new Promise<void>(() => {});
}
