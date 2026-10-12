import Fastify from 'fastify';
import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry, LOCALES } from '../../src/core/index.js';
import { registerMcpRoutes, McpSessionStore } from '../../src/adapters/mcp/index.js';
import { createGuardrails } from '../../src/adapters/mcp/guardrails.js';
import {
  OAUTH_PROTECTED_RESOURCE_PATH,
  oauthProtectedResourceMetadata,
  wwwAuthenticateChallenge,
} from '../../src/adapters/auth/index.js';
import { setErrorHandlers } from '../../src/adapters/rest/errorHandler.js';
import type { McpEngine } from '../../src/adapters/mcp/types.js';

const OIDC = { issuer: 'https://idp.example.com', resource: 'https://engine.example.com' };

describe('OAuth protected-resource metadata', () => {
  it('builder derives authorization_servers from the issuer and honours resource/scopes', () => {
    expect(oauthProtectedResourceMetadata(OIDC, 'http://localhost:3000')).toEqual({
      resource: 'https://engine.example.com',
      authorization_servers: ['https://idp.example.com'],
      bearer_methods_supported: ['header'],
    });
    expect(oauthProtectedResourceMetadata({ issuer: 'https://idp', scopes: ['openid'] }, 'https://x')).toMatchObject({
      resource: 'https://x',
      authorization_servers: ['https://idp'],
      scopes_supported: ['openid'],
    });
    expect(oauthProtectedResourceMetadata(undefined, 'https://x')).toBeUndefined();
  });

  it('challenge points at the metadata document', () => {
    expect(wwwAuthenticateChallenge('https://engine.example.com')).toBe(
      `Bearer resource_metadata="https://engine.example.com${OAUTH_PROTECTED_RESOURCE_PATH}"`,
    );
  });

  it('serves the metadata document and a 401 challenge when auth.oidc is set', async () => {
    const app = Fastify();
    const registry = new ObjectRegistry();
    registry.buildGraph();
    registerMcpRoutes(app, {
      engine: { registry, pool: {} as never, dataAccess: {} as never, locale: LOCALES.EN } as McpEngine,
      authenticator: { resolve: async () => null },
      identityResolver: () => null,
      guardrails: createGuardrails({}),
      sessionStore: new McpSessionStore(),
      locale: LOCALES.EN,
      oauth: OIDC,
    });
    setErrorHandlers(app, LOCALES.EN, {
      wwwAuthenticate: (request) => wwwAuthenticateChallenge(`${request.protocol}://${request.host}`),
    });
    try {
      const meta = await app.inject({ method: 'GET', url: OAUTH_PROTECTED_RESOURCE_PATH });
      expect(meta.statusCode).toBe(200);
      expect(meta.json()).toEqual({
        resource: 'https://engine.example.com',
        authorization_servers: ['https://idp.example.com'],
        bearer_methods_supported: ['header'],
      });

      const unauth = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
      expect(unauth.statusCode).toBe(401);
      expect(unauth.headers['www-authenticate']).toContain(`resource_metadata=`);
      expect(unauth.headers['www-authenticate']).toContain(OAUTH_PROTECTED_RESOURCE_PATH);
    } finally {
      await app.close();
    }
  });
});
