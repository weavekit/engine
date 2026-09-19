import { connectTunnel } from '../../runtime/tunnel/index.js';
import { createPrinter } from '../render.js';

/**
 * `weave connect` (P1, agent): dial a customer engine OUT to a governance tunnel
 * endpoint over a persistent HTTP/2 CONNECT stream, so a NAT'd/on-prem engine is
 * governable without a routable URL. Runs until Ctrl+C; the local engine is left
 * untouched (only read/approved governance paths are forwarded).
 */

export interface ConnectOptions {
  /** governance tunnel endpoint (http/https). */
  endpoint: string;
  /** connections.tunnel_id. */
  tunnel: string;
  /** connections.pairing_token. */
  token: string;
  /** local customer engine base url. */
  engine: string;
  /** customer engine api key (auth to the local engine). */
  apiKey?: string;
  /** skip TLS certificate verification (self-hosted/dev). */
  insecure?: boolean;
}

export async function connect(_cwd: string, options: ConnectOptions): Promise<void> {
  const printer = createPrinter({ json: false });
  if (!options.apiKey) {
    printer.error('--api-key is required (customer engine auth key)');
    process.exitCode = 1;
    return;
  }

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
    printer.error(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    handle.close();
    return;
  }

  printer.log(`tunnel established: ${options.tunnel} → ${options.engine} (${options.endpoint})`);
  const shutdown = (): void => {
    handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // the open HTTP/2 session keeps the event loop alive; block until signalled
  await new Promise<void>(() => {});
}
