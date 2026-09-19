import { describe, it, expect } from '../helpers/test.js';import { createSlidingWindow } from '../../src/core/limiter/index.js';

describe('createSlidingWindow', () => {
  it('passes within window, rejects after reaching max', () => {
    const l = createSlidingWindow({ windowMs: 1000, max: 2 });
    expect(l.check('a', 0)).toBe(true);
    expect(l.check('a', 10)).toBe(true);
    expect(l.check('a', 20)).toBe(false);
    expect(l.check('a', 30)).toBe(false);
  });

  it('different keys are independent', () => {
    const l = createSlidingWindow({ windowMs: 1000, max: 1 });
    expect(l.check('a', 0)).toBe(true);
    expect(l.check('a', 5)).toBe(false);
    expect(l.check('b', 10)).toBe(true);
  });

  it('allows passing again after window slides', () => {
    const l = createSlidingWindow({ windowMs: 100, max: 1 });
    expect(l.check('k', 0)).toBe(true);
    expect(l.check('k', 50)).toBe(false);
    expect(l.check('k', 150)).toBe(true); // 100ms window slid past
  });

  it('default parameters (60s / 100)', () => {
    const l = createSlidingWindow();
    for (let i = 0; i < 100; i++) expect(l.check('k')).toBe(true);
    expect(l.check('k')).toBe(false);
  });

  it('clear wipes all hits', () => {
    const l = createSlidingWindow({ windowMs: 1000, max: 1 });
    expect(l.check('a', 0)).toBe(true);
    expect(l.check('a', 5)).toBe(false);
    l.clear();
    expect(l.check('a', 10)).toBe(true);
  });
});
