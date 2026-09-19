import { describe, it, expect } from '../helpers/test.js';
import { readyScreen } from '../../src/cli/ready-screen.js';

describe('readyScreen — weave dev value screen', () => {
  it('lists endpoints/objects/capabilities and next steps', () => {
    const screen = readyScreen({
      port: 3000,
      projectType: 'agent',
      restEnabled: true,
      restPrefix: '/api',
      mcpEnabled: true,
      mcpEndpoint: '/mcp',
      eventsEnabled: true,
      eventsPrefix: '/api',
      objects: ['customers', 'orders'],
      audit: true,
      script: false,
      events: true,
      customTools: 2,
      apiKey: 'sk-admin',
    });

    expect(screen.projectType).toBe('agent');
    expect(screen.endpoints).toEqual([
      { label: 'REST', url: 'http://localhost:3000/api', note: 'objects' },
      { label: 'MCP', url: 'http://localhost:3000/mcp', note: 'tools for agents' },
      { label: 'events', url: 'http://localhost:3000/api/events', note: 'live SSE' },
    ]);
    expect(screen.objects).toEqual(['customers', 'orders']);
    expect(screen.empty).toBe(false);
    expect(screen.capabilities).toEqual([
      { label: 'audit', value: 'on' },
      { label: 'script', value: 'off' },
      { label: 'events', value: 'on' },
      { label: 'custom tools', value: '2' },
    ]);
    expect(screen.nextSteps[0]).toContain('Bearer sk-admin');
    expect(screen.nextSteps[0]).toContain('/api/objects/customers');
    expect(screen.nextSteps.join('\n')).toContain('weave mcp:config');
    expect(screen.nextSteps.join('\n')).toContain('docs/practices/connect-agent.md');
  });

  it('guides first-run (introspect / object:create) when there are no objects', () => {
    const screen = readyScreen({
      port: 3000,
      restEnabled: true,
      restPrefix: '/api',
      mcpEnabled: true,
      mcpEndpoint: '/mcp',
      eventsEnabled: false,
      eventsPrefix: '/api',
      objects: [],
      audit: false,
      script: false,
      events: false,
      customTools: 0,
    });

    expect(screen.empty).toBe(true);
    expect(screen.nextSteps.join('\n')).toContain('weave introspect');
    expect(screen.nextSteps.join('\n')).toContain('weave object:create');
    expect(screen.endpoints.some((e) => e.label === 'events')).toBe(false);
    expect(screen.apiKey).toBeUndefined();
  });

  it('uses a placeholder key when no static key is configured', () => {
    const screen = readyScreen({
      port: 3000,
      restEnabled: true,
      restPrefix: '/api',
      mcpEnabled: true,
      mcpEndpoint: '/mcp',
      eventsEnabled: false,
      eventsPrefix: '/api',
      objects: ['leads'],
      audit: false,
      script: false,
      events: false,
      customTools: 0,
    });

    expect(screen.nextSteps[0]).toContain('<your API key>');
  });
});
