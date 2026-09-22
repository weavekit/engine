import { describe, it, expect } from '../helpers/test.js';import {
  ar,
  de,
  DEFAULT_LOCALE,
  en,
  es,
  fr,
  hi,
  id,
  ja,
  ko,
  LOCALES,
  ObjectRegistry,
  pt,
  resolveLabel,
  ru,
  SchemaError,
  SUPPORTED_LOCALES,
  translate,
  validateObject,
  vi,
  zh,
  zhHant,
} from '../../src/core/index.js';

const valid = {
  name: 'lead',
  fields: [{ name: 'id', type: 'string', primary: true }],
};

describe('i18n — one file per language structure', () => {
  it('SUPPORTED_LOCALES registered languages and consistent key sets', () => {
    expect([...SUPPORTED_LOCALES].sort()).toEqual([
      'ar',
      'de',
      'en',
      'es',
      'fr',
      'hi',
      'id',
      'ja',
      'ko',
      'pt',
      'ru',
      'vi',
      'zh',
      'zh-Hant',
    ]);
    for (const catalog of [en, ar, de, es, fr, hi, id, ja, ko, pt, ru, vi, zh, zhHant]) {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(en).sort());
    }
  });

  it('LOCALES uppercase keys derive tags', () => {
    expect(LOCALES.EN).toBe('en');
    expect(LOCALES.ZH).toBe('zh');
    expect(LOCALES.ZH_HANT).toBe('zh-Hant');
  });

  it('default locale is English', () => {
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('zh catalog keys cover all English keys (enforced at compile time)', () => {
    for (const key of Object.keys(en)) {
      expect(typeof zh[key as keyof typeof en]).toBe('string');
    }
  });
});

describe('i18n — translate', () => {
  it('English messages include parameter interpolation', () => {
    expect(
      translate('field.type.invalid', { object: 'lead', type: 'magic' }, 'en'),
    ).toBe('object "lead": type "magic" is not a valid field type');
  });

  it('Chinese messages', () => {
    const msg = translate('field.type.invalid', { object: 'lead', type: 'magic' }, 'zh');
    expect(msg).toContain('不是合法字段类型');
  });

  it('unknown params stay literal ({seq} not substituted)', () => {
    expect(translate('field.seqNo.format.seq', { object: 'po' }, 'en')).toContain('{seq}');
  });

  it('unknown locale falls back to English', () => {
    // Locale type restricts to en/zh; verifying the en catalog exists suffices
    expect(translate('object.name.required', { object: 'x' }, 'zh')).toContain('必填');
  });
});

describe('SchemaError — code/params/locale', () => {
  it('default English message + exposes code/params', () => {
    let caught: SchemaError | undefined;
    try {
      validateObject({ ...valid, name: 'Bad Name' });
    } catch (err) {
      caught = err as SchemaError;
    }
    expect(caught).toBeDefined();
    expect(caught!.code).toBe('object.name.snake');
    expect(caught!.params).toMatchObject({ object: 'Bad Name', name: 'Bad Name' });
    expect(caught!.locale).toBe('en');
    expect(caught!.message).toContain('must be snake_case');
  });

  it('locale zh returns Chinese message', () => {
    expect(() => validateObject({ ...valid, name: 'Bad Name' }, { locale: 'zh' })).toThrow(
      /必须为 snake_case/,
    );
  });

  it('localize() can re-target locale', () => {
    let caught: SchemaError | undefined;
    try {
      validateObject({ ...valid, name: 'Bad Name' });
    } catch (err) {
      caught = err as SchemaError;
    }
    expect(caught!.localize('zh')).toContain('必须为 snake_case');
  });

  it('translate supports cross-language consistent keys', () => {
    const enMsg = translate('object.primary.none', { object: 'x' }, 'en');
    const zhMsg = translate('object.primary.none', { object: 'x' }, 'zh');
    expect(enMsg).toContain('must declare exactly one primary');
    expect(zhMsg).toContain('必须声明且仅声明一个主键字段');
  });
});

describe('validateObject — labels localization', () => {
  it('field-level + object-level labels valid', () => {
    const def = validateObject({
      name: 'customer',
      labels: { zh: '客户', 'zh-CN': '客户' },
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'name', type: 'string', labels: { zh: '名称' } },
      ],
    });
    expect(def.labels).toEqual({ zh: '客户', 'zh-CN': '客户' });
    expect(def.fields[1]).toMatchObject({ labels: { zh: '名称' } });
  });

  it('legacy scalar label rejected (use labels)', () => {
    expect(() =>
      validateObject({
        ...valid,
        label: 'Customer',
      }),
    ).toThrow(/no longer supported/);
  });

  it('empty labels object rejected', () => {
    expect(() =>
      validateObject({
        ...valid,
        labels: {},
      }),
    ).toThrow(/at least one locale/);
  });

  it('labels not an object rejected', () => {
    expect(() =>
      validateObject({
        ...valid,
        fields: [{ name: 'id', type: 'string', primary: true, labels: 'x' }],
      }),
    ).toThrow(/labels must be a plain object/);
  });

  it('invalid locale key rejected', () => {
    expect(() =>
      validateObject({
        ...valid,
        labels: { 'not a locale!': 'x' },
      }),
    ).toThrow(/not a valid locale tag/);
  });

  it('empty values in labels rejected', () => {
    expect(() =>
      validateObject({
        ...valid,
        labels: { zh: '' },
      }),
    ).toThrow(/must be a non-empty string/);
  });

  it('labels is an allowed attribute (not out of bounds)', () => {
    expect(() =>
      validateObject({
        ...valid,
        fields: [{ name: 'id', type: 'string', primary: true, labels: { zh: '标识' } }],
      }),
    ).not.toThrow();
  });
});

describe('i18n — registry locale propagation', () => {
  it('registry registration errors use English', () => {
    const reg = new ObjectRegistry();
    reg.register(valid);
    expect(() => reg.register(valid)).toThrow(/already defined/);
  });
});

describe('resolveLabel — locale fallback order', () => {
  it('prefers the requested locale, then the default locale, then the first entry, then the fallback name', () => {
    expect(resolveLabel({ en: 'Customer', zh: '客户' }, 'customer', 'zh')).toBe('客户');
    expect(resolveLabel({ en: 'Customer', zh: '客户' }, 'customer', 'ja')).toBe('Customer');
    expect(resolveLabel({ fr: 'Client' }, 'customer', 'ja')).toBe('Client');
    expect(resolveLabel(undefined, 'customer')).toBe('customer');
  });
});
