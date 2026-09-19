import type {
  ScriptServices,
  ScriptWebhookCallOptions,
} from '../../core/index.js';

/**
 * Default script-service implementations (main-process side of the bridge).
 * The sandbox never performs network I/O itself — these run in the engine
 * process and can be replaced via `subsystems.script.services`.
 *
 * email/slack require external credentials and throw "not configured" until
 * the caller supplies an implementation (e.g. nodemailer / a webhook URL via
 * env); webhook is functional out of the box (documented whitelist escape).
 */
export function createDefaultScriptServices(options: { fetch?: typeof globalThis.fetch } = {}): ScriptServices {
  const fetchFn = options.fetch ?? globalThis.fetch;
  return {
    email: {
      async send() {
        throw new Error('services.email is not configured — provide subsystems.script.services');
      },
    },
    slack: {
      async post() {
        throw new Error('services.slack is not configured — provide subsystems.script.services');
      },
    },
    webhook: {
      async call(opts: ScriptWebhookCallOptions) {
        if (typeof fetchFn !== 'function') throw new Error('webhook.call requires a fetch implementation');
        const response = await fetchFn(opts.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
          body: opts.payload === undefined ? undefined : JSON.stringify(opts.payload),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`webhook.call failed: HTTP ${response.status}`);
        const text = await response.text();
        if (text === '') return undefined;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      },
    },
  };
}
