import { describe, it, expect } from '../helpers/test.js';import { SchemaError, primaryKeyOf, validateObject } from '../../src/core/index.js';

const base = {
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'status', type: 'enum', options: ['open', 'closed'], default: 'open' },
  ],
};

describe('validateObject — object level', () => {
  it('valid object passes and primary key identified', () => {
    const def = validateObject(base);
    expect(def.name).toBe('lead');
    expect(primaryKeyOf(def)).toBe('id');
  });

  it('object name must be snake_case', () => {
    expect(() => validateObject({ ...base, name: 'Lead' })).toThrow(SchemaError);
    expect(() => validateObject({ ...base, name: 'lead_order' })).not.toThrow();
  });

  it('name is required', () => {
    expect(() => validateObject({ ...base, name: undefined })).toThrow(SchemaError);
  });

  it('at least one field', () => {
    expect(() => validateObject({ ...base, fields: [] })).toThrow(SchemaError);
    expect(() => validateObject({ ...base, fields: undefined })).toThrow(SchemaError);
  });

  it('duplicate field name rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'id', type: 'string' },
        ],
      }),
    ).toThrow(SchemaError);
  });

  it('nameHint inconsistent with directory name rejected', () => {
    expect(() => validateObject(base, { nameHint: 'other' })).toThrow(SchemaError);
    expect(() => validateObject(base, { nameHint: 'lead' })).not.toThrow();
  });
});

describe('validateObject — primary key rules', () => {
  it('every object must have exactly one primary', () => {
    const noPrimary = { ...base, fields: [{ name: 'id', type: 'string' }] };
    expect(() => validateObject(noPrimary)).toThrow(/must declare exactly one primary/);

    const twoPrimary = {
      ...base,
      fields: [
        { name: 'a', type: 'string', primary: true },
        { name: 'b', type: 'string', primary: true },
      ],
    };
    expect(() => validateObject(twoPrimary)).toThrow(/may only have one primary/);
  });

  it('object does not declare table attribute (object name is table name)', () => {
    const def = validateObject(base);
    expect('table' in def).toBe(false);
    expect(primaryKeyOf(def)).toBe('id');
  });

  it('primary cannot be relation/details', () => {
    const relPrimary = {
      ...base,
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'owner_id', type: 'relation', target: 'user', primary: true },
      ],
    };
    expect(() => validateObject(relPrimary)).toThrow(/may only have one primary/);

    const detailsPrimary = {
      ...base,
      fields: [
        { name: 'lines', type: 'details', target: 'line', primary: true },
        { name: 'id', type: 'string', primary: true },
      ],
    };
    expect(() => validateObject(detailsPrimary)).toThrow(/may only have one primary/);
  });
});

describe('validateObject — field level', () => {
  it('invalid type rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [{ name: 'id', type: 'string', primary: true }, { name: 'x', type: 'magic' }],
      }),
    ).toThrow(/not a valid field type/);
  });

  it('field name must be snake_case', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [{ name: 'id', type: 'string', primary: true }, { name: 'Foo', type: 'string' }],
      }),
    ).toThrow(/snake_case/);
  });

  it('out-of-scope attribute rejected (required written on details)', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'lines', type: 'details', target: 'line', required: true },
        ],
      }),
    ).toThrow(/does not allow attribute "required"/);
  });

  it('out-of-scope attribute rejected (onDelete written on string)', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'x', type: 'string', onDelete: 'cascade' },
        ],
      }),
    ).toThrow(/does not allow attribute "onDelete"/);
  });

  it('misspelled attribute name rejected (requried)', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'x', type: 'string', requried: true },
        ],
      }),
    ).toThrow(/does not allow attribute "requried"/);
  });

  it('enum must have non-empty options', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [{ name: 'id', type: 'string', primary: true }, { name: 's', type: 'enum' }],
      }),
    ).toThrow(/options/);
  });

  it('duplicate enum options rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 's', type: 'enum', options: ['a', 'a'] },
        ],
      }),
    ).toThrow(/duplicate value/);
  });

  it('enum default must be in options', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 's', type: 'enum', options: ['a', 'b'], default: 'z' },
        ],
      }),
    ).toThrow(/not in options/);
  });

  it('min greater than max rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'n', type: 'integer', min: 10, max: 1 },
        ],
      }),
    ).toThrow(/must not be greater than max/);
  });

  it('invalid regex rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'x', type: 'string', regex: '(' },
        ],
      }),
    ).toThrow(/not a valid regular expression/);
  });

  it('integer default type validation', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'n', type: 'integer', default: 1.5 },
        ],
      }),
    ).toThrow(/must be an integer/);
  });

  it('relation must have target', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'owner_id', type: 'relation' },
        ],
      }),
    ).toThrow(/target/);
  });

  it('onDelete valid values', () => {
    const ok = validateObject({
      ...base,
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'owner_id', type: 'relation', target: 'user', onDelete: 'set_null' },
      ],
    });
    expect(ok.fields[1]).toMatchObject({ type: 'relation', target: 'user', onDelete: 'set_null' });

    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'owner_id', type: 'relation', target: 'user', onDelete: 'boom' },
        ],
      }),
    ).toThrow(/onDelete/);
  });
});

describe('validateObject — multiRelation', () => {
  it('valid multiRelation (required optional, defaults false)', () => {
    const def = validateObject({
      name: 'customer',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'contacts', type: 'multiRelation', target: 'contact' },
      ],
    });
    expect(def.fields[1]).toMatchObject({ type: 'multiRelation', target: 'contact' });
  });

  it('missing target rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'contacts', type: 'multiRelation' },
        ],
      }),
    ).toThrow(/target/);
  });

  it('out-of-scope attribute rejected (onDelete/unique/default)', () => {
    for (const extra of [
      { name: 'contacts', type: 'multiRelation', target: 'contact', onDelete: 'cascade' },
      { name: 'contacts', type: 'multiRelation', target: 'contact', unique: true },
      { name: 'contacts', type: 'multiRelation', target: 'contact', default: [] },
    ]) {
      expect(() =>
        validateObject({
          ...base,
          fields: [{ name: 'id', type: 'string', primary: true }, extra],
        }),
      ).toThrow(/does not allow attribute/);
    }
  });

  it('cannot be a primary key', () => {
    expect(() =>
      validateObject({
        name: 'customer',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'contacts', type: 'multiRelation', target: 'contact', primary: true },
        ],
      }),
    ).toThrow(/may only have one primary/);
  });
});

describe('validateObject — seq_no sequence number', () => {
  it('valid seq_no', () => {
    const def = validateObject({
      name: 'purchase_order',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'doc_no', type: 'seq_no', format: 'PO-{year}-{seq:6}', cycle: 'year' },
      ],
    });
    expect(def.fields[1]).toMatchObject({
      type: 'seq_no',
      format: 'PO-{year}-{seq:6}',
      cycle: 'year',
    });
  });

  it('format missing {seq} rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'doc_no', type: 'seq_no', format: 'PO-{year}' },
        ],
      }),
    ).toThrow(/must contain the \{seq\} placeholder/);
  });

  it('format with unsupported placeholder rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'doc_no', type: 'seq_no', format: 'PO-{seq}-{foo}' },
        ],
      }),
    ).toThrow(/unsupported placeholder/);
  });

  it('cycle only none/year', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'doc_no', type: 'seq_no', format: '{seq}', cycle: 'month' },
        ],
      }),
    ).toThrow(/cycle/);
  });

  it('cannot be a primary key', () => {
    expect(() =>
      validateObject({
        name: 'purchase_order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'doc_no', type: 'seq_no', primary: true },
        ],
      }),
    ).toThrow(/may only have one primary/);

    expect(() =>
      validateObject({
        name: 'purchase_order',
        fields: [{ name: 'doc_no', type: 'seq_no', primary: true }],
      }),
    ).toThrow(/only allows scalar field types/);
  });

  it('out-of-scope attribute rejected (required/unique/default/target)', () => {
    for (const extra of [
      { name: 'doc_no', type: 'seq_no', required: true },
      { name: 'doc_no', type: 'seq_no', unique: true },
      { name: 'doc_no', type: 'seq_no', default: 1 },
      { name: 'doc_no', type: 'seq_no', target: 'x' },
    ]) {
      expect(() =>
        validateObject({
          ...base,
          fields: [{ name: 'id', type: 'string', primary: true }, extra],
        }),
      ).toThrow(/does not allow attribute/);
    }
  });
});

describe('validateObject — titleTemplate', () => {
  it('valid composite title', () => {
    const def = validateObject({
      name: 'customer',
      titleTemplate: '{doc_no} {name}',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'doc_no', type: 'seq_no', format: '{seq}' },
        { name: 'name', type: 'string' },
      ],
    });
    expect(def.titleTemplate).toBe('{doc_no} {name}');
  });

  it('placeholder referencing nonexistent field rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        titleTemplate: '{ghost}',
      }),
    ).toThrow(/references a missing field/);
  });

  it('placeholder referencing relation field rejected', () => {
    expect(() =>
      validateObject({
        name: 'customer',
        titleTemplate: '{contacts}',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'contacts', type: 'multiRelation', target: 'contact' },
        ],
      }),
    ).toThrow(/cannot reference a multiRelation field/);
  });

  it('placeholder referencing multi-select enum rejected', () => {
    expect(() =>
      validateObject({
        name: 'customer',
        titleTemplate: '{tags}',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'tags', type: 'enum', options: ['a', 'b'], multiple: true },
        ],
      }),
    ).toThrow(/multi-value enum field/);
  });
});

describe('validateObject — string subtypes / image / person', () => {
  it('firstName/lastName/email/phone valid and normalized to string semantics', () => {
    const def = validateObject({
      name: 'profile',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'first', type: 'firstName', required: true },
        { name: 'last', type: 'lastName', required: true },
        { name: 'email', type: 'email', unique: true },
        { name: 'phone', type: 'phone' },
      ],
    });
    const byName = new Map(def.fields.map((f) => [f.name, f]));
    expect(byName.get('first')).toMatchObject({ type: 'firstName', required: true });
    expect(byName.get('email')).toMatchObject({ type: 'email', unique: true });
    expect(byName.get('phone')).toMatchObject({ type: 'phone' });
  });

  it('invalid type rejected', () => {
    expect(() => validateObject({ name: 'x', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'a', type: 'firstName', minLength: -1 }] })).toThrow(SchemaError);
  });

  it('person requires target and snake_case; person placeholder valid', () => {
    expect(() =>
      validateObject({ name: 'c', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'o', type: 'person' }] }),
    ).toThrow(/target/);
    const def = validateObject({
      name: 'c',
      titleTemplate: '{owner}',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'owner', type: 'person', target: 'employees' },
      ],
    });
    expect(def.titleTemplate).toBe('{owner}');
  });

  it('image single/multiple valid', () => {
    const def = validateObject({
      name: 'product',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'photo', type: 'image' },
        { name: 'gallery', type: 'image', multiple: true },
      ],
    });
    const byName = new Map(def.fields.map((f) => [f.name, f]));
    expect(byName.get('photo')).toMatchObject({ type: 'image' });
    expect(byName.get('gallery')).toMatchObject({ type: 'image', multiple: true });
  });
});

describe('validateObject — department + person.department + features.fieldTypes gating', () => {
  it('department requires target; person.department serialized and exposed', () => {
    expect(() =>
      validateObject({ name: 'c', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'd', type: 'department' }] }),
    ).toThrow(/target/);
    const def = validateObject({
      name: 'employee',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'dept_id', type: 'department', target: 'department' },
        { name: 'manager_id', type: 'person', target: 'employee', department: 'dept_id' },
      ],
    });
    const byName = new Map(def.fields.map((f) => [f.name, f]));
    expect(byName.get('dept_id')).toMatchObject({ type: 'department', target: 'department' });
    expect(byName.get('manager_id')).toMatchObject({ type: 'person', target: 'employee', department: 'dept_id' });
  });

  it('allowedFieldTypes whitelist fail-closed (disabled types rejected)', () => {
    expect(() =>
      validateObject(
        { name: 'c', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'owner', type: 'person', target: 'users' }] },
        { allowedFieldTypes: ['string', 'integer'] },
      ),
    ).toThrow(/disabled/);
    expect(() =>
      validateObject(
        { name: 'c', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'owner', type: 'relation', target: 'users' }] },
        { allowedFieldTypes: ['string', 'relation'] },
      ),
    ).not.toThrow();
  });
});

describe('validateObject — fields.create whitelist', () => {
  const base = {
    name: 'note',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'title', type: 'string', required: true },
      { name: 'status', type: 'enum', options: ['draft', 'done'] },
      { name: 'owner_id', type: 'string', ownership: true },
      { name: 'secret', type: 'string' },
    ],
    permissions: { editor: { read: 'own', create: true, update: ['status'], fields: { create: ['title', 'status'] } } },
  };

  it('valid whitelist passes and is preserved', () => {
    const def = validateObject(base);
    expect(def.permissions?.editor?.fields?.create).toEqual(['title', 'status']);
  });

  it('non-string array rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        permissions: { editor: { read: 'own', create: true, fields: { create: 'title' } } },
      }),
    ).toThrow(SchemaError);
  });

  it('reference to unknown field rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        permissions: { editor: { read: 'own', create: true, fields: { create: ['title', 'ghost'] } } },
      }),
    ).toThrow(/unknown field/);
  });

  it('missing required field rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        permissions: { editor: { read: 'own', create: true, fields: { create: ['status'] } } },
      }),
    ).toThrow(/required field/);
  });
});

describe('validateObject — system fields', () => {
  it('system:true valid (scalar/seq_no/relation)', () => {
    const def = validateObject({
      name: 'lead',
      fields: [
        { name: 'object_id', type: 'string', primary: true, system: true },
        { name: 'doc_no', type: 'seq_no', format: '{seq}', system: true },
        { name: 'created_time', type: 'datetime', system: true, default: 'now' },
        { name: 'created_by', type: 'relation', target: 'user', system: true },
      ],
    });
    expect(def.fields[0]).toMatchObject({ name: 'object_id', system: true, primary: true });
    expect(def.fields[2]).toMatchObject({ name: 'created_time', system: true });
  });

  it('system defaults to false', () => {
    const def = validateObject(base);
    expect(def.fields[0]!.system).toBeUndefined();
  });

  it('system non-boolean rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [{ name: 'id', type: 'string', primary: true, system: 'yes' }],
      }),
    ).toThrow(/attribute "system" must be a boolean/);
  });
});

describe('validateObject — enum multiple', () => {
  it('valid multi-select enum (default array + subset of options)', () => {
    const def = validateObject({
      name: 'lead',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'tags', type: 'enum', options: ['a', 'b', 'c'], multiple: true, default: ['a', 'b'] },
      ],
    });
    expect(def.fields[1]).toMatchObject({ type: 'enum', multiple: true, default: ['a', 'b'] });
  });

  it('single-select enum default is a string', () => {
    const def = validateObject({
      ...base,
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 's', type: 'enum', options: ['a', 'b'], default: 'a' },
      ],
    });
    expect(def.fields[1]).toMatchObject({ multiple: undefined, default: 'a' });
  });

  it('multiple default non-array rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'tags', type: 'enum', options: ['a', 'b'], multiple: true, default: 'a' },
        ],
      }),
    ).toThrow(/must be a string array/);
  });

  it('multiple default out-of-range options rejected', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'tags', type: 'enum', options: ['a', 'b'], multiple: true, default: ['a', 'z'] },
        ],
      }),
    ).toThrow(/not in options/);
  });

  it('multiple cannot be primary', () => {
    expect(() =>
      validateObject({
        name: 'lead',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'tags', type: 'enum', options: ['a', 'b'], multiple: true, primary: true },
        ],
      }),
    ).toThrow(/cannot be primary/);
  });

  it('multiple does not support unique', () => {
    expect(() =>
      validateObject({
        ...base,
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'tags', type: 'enum', options: ['a', 'b'], multiple: true, unique: true },
        ],
      }),
    ).toThrow(/does not support unique/);
  });
});
