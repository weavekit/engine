import { describe, it, expect } from '../helpers/test.js';
import {
  detectScriptHooks,
  invalidScriptHookSignatures,
  transformScriptSource,
} from '../../src/core/index.js';

describe('transformScriptSource', () => {
  it('rewrites declaration exports', () => {
    const out = transformScriptSource('export function onLoad() {}\nexport const x = 1;');
    expect(out).toContain('__exports.onLoad = function onLoad() {}');
    expect(out).toContain('__exports.x = ');
    expect(out).not.toContain('export function');
  });

  it('keeps async function exports async', () => {
    const out = transformScriptSource('export async function afterUpdate() {}');
    expect(out).toContain('__exports.afterUpdate = async function afterUpdate() {}');
  });

  it('rewrites export default', () => {
    const out = transformScriptSource('export default function named() {}');
    expect(out).toContain('__exports.default = function named() {}');
  });

  it('rewrites a named export list, including aliases', () => {
    const out = transformScriptSource('function onLoad() {}\nconst validate = () => {};\nexport { onLoad, validate as v };');
    expect(out).toContain('__exports.onLoad = onLoad;');
    expect(out).toContain('__exports.v = validate;');
    expect(out).not.toContain('export {');
  });

  it('turns a re-export `from` into a fail-closed undefined binding', () => {
    const out = transformScriptSource("export { onLoad } from './other.js';");
    expect(out).toContain('__exports.onLoad = onLoad;');
    expect(out).not.toContain('from');
  });
});

describe('detectScriptHooks — list form', () => {
  it('detects hooks exported via a named list', () => {
    expect(detectScriptHooks('function onLoad() {}\nexport { onLoad };')).toEqual(['onLoad']);
  });

  it('detects the exported (aliased) name', () => {
    expect(detectScriptHooks('const fn = () => {};\nexport { fn as validate };')).toEqual(['validate']);
  });

  it('ignores non-hook exports', () => {
    expect(detectScriptHooks('export const helper = 1;')).toEqual([]);
  });
});

describe('invalidScriptHookSignatures — list form', () => {
  it('accepts a parameterless local declaration exported via a list', () => {
    expect(invalidScriptHookSignatures('function onLoad() {}\nexport { onLoad };')).toEqual([]);
  });

  it('rejects a local declaration that declares parameters', () => {
    expect(invalidScriptHookSignatures('function onLoad(a) {}\nexport { onLoad };')).toEqual(['onLoad']);
  });
});
