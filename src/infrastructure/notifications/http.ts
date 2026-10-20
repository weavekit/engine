import type { FetchLike } from '../../core/provider/notifications/index.js';

export interface PostJsonOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/** POST JSON with a bounded timeout; callers check `response.ok`. */
export async function postJson(
  url: string,
  body: unknown,
  options: PostJsonOptions = {},
): Promise<Response> {
  const doFetch = options.fetch ?? globalThis.fetch;
  return doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  });
}
