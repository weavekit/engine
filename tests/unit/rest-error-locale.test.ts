import { describe, it, expect } from '../helpers/test.js';
import Fastify from 'fastify';
import { setErrorHandlers } from '../../src/adapters/rest/errorHandler.js';
import { SchemaError, translate } from '../../src/core/index.js';

async function buildApp(fallback: 'en' | 'zh' = 'en') {
  const app = Fastify();
  setErrorHandlers(app, fallback);
  app.get('/boom', async () => {
    throw new SchemaError('auth.missingKey');
  });
  await app.ready();
  return app;
}

describe('REST error locale negotiation', () => {
  it('renders errors in the request Accept-Language', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/boom', headers: { 'accept-language': 'zh-CN' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('auth.missingKey');
    expect(res.json().error.message).toBe(translate('auth.missingKey', {}, 'zh'));
    expect(res.headers.vary).toBe('Accept-Language');
    await app.close();
  });

  it('falls back to the configured locale without a header', async () => {
    const app = await buildApp('en');
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.json().error.message).toBe(translate('auth.missingKey', {}, 'en'));
    await app.close();
  });

  it('ignores unsupported languages and wildcards', async () => {
    const app = await buildApp('zh');
    const res = await app.inject({ method: 'GET', url: '/boom', headers: { 'accept-language': 'xx-YY, *' } });
    expect(res.json().error.message).toBe(translate('auth.missingKey', {}, 'zh'));
    await app.close();
  });

  it('localizes the not-found handler too', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/missing', headers: { 'accept-language': 'zh' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe(translate('http.notFound', {}, 'zh'));
    expect(res.headers.vary).toBe('Accept-Language');
    await app.close();
  });
});
