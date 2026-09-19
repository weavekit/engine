import { describe, it, expect } from "../helpers/test.js";
import {
  buildColumns,
  buildFindSql,
  buildWhere,
  defineObject,
  resolvePagination,
  SchemaError,
  type FindOptions,
} from "../../src/index.js";

const order = defineObject({
  name: "order",
  fields: [
    { name: "id", type: "string", primary: true },
    { name: "amount", type: "currency" },
    { name: "status", type: "enum", options: ["open", "closed"] },
    { name: "tags", type: "enum", options: ["a", "b"], multiple: true },
  ],
});
const ctx = { object: "order" };

describe("buildWhere — filter → SQL", () => {
  it("eq default", () => {
    const { sql, params } = buildWhere(order, { status: "open" }, ctx);
    expect(sql).toBe('WHERE "status" = $1');
    expect(params).toEqual(["open"]);
  });

  it("comparison operators", () => {
    const { sql, params } = buildWhere(order, { amount: { gte: 100 } }, ctx);
    expect(sql).toBe('WHERE "amount" >= $1');
    expect(params).toEqual([100]);
  });

  it("multiple operators on same field → parenthesized AND (date/time range)", () => {
    const { sql, params } = buildWhere(order, { amount: { gte: 100, lte: 500 } }, ctx);
    expect(sql).toBe('WHERE ("amount" >= $1 AND "amount" <= $2)');
    expect(params).toEqual([100, 500]);
  });

  it("contains → @> ::text[]", () => {
    const { sql, params } = buildWhere(
      order,
      { tags: { contains: ["a", "b"] } },
      ctx,
    );
    expect(sql).toBe('WHERE "tags" @> $1::text[]');
    expect(params).toEqual([["a", "b"]]);
  });

  it("like → ILIKE %value% (scalar substring)", () => {
    const { sql, params } = buildWhere(order, { status: { like: "ope" } }, ctx);
    expect(sql).toBe('WHERE "status" ILIKE $1');
    expect(params).toEqual(["%ope%"]);
  });

  it("$or across groups OR + parentheses", () => {
    const { sql, params } = buildWhere(
      order,
      { $or: [{ status: "open" }, { amount: { gte: 100 } }] },
      ctx,
    );
    expect(sql).toBe('WHERE (("status" = $1) OR ("amount" >= $2))');
    expect(params).toEqual(["open", 100]);
  });

  it("$or within-group AND, ANDed with top-level field conditions", () => {
    const { sql } = buildWhere(
      order,
      {
        status: "closed",
        $or: [
          { status: "open", amount: { gt: 5 } },
          { tags: { contains: ["a"] } },
        ],
      },
      ctx,
    );
    expect(sql).toBe(
      'WHERE (("status" = $1 AND "amount" > $2) OR ("tags" @> $3::text[])) AND "status" = $4',
    );
  });

  it("$or and rowScope both ANDed", () => {
    const { sql } = buildWhere(
      order,
      { $or: [{ status: "open" }, { status: "closed" }] },
      ctx,
      { sql: '"owner_id" = $1', params: ["u1"] },
    );
    expect(sql).toBe(
      'WHERE (("status" = $1) OR ("status" = $2)) AND ("owner_id" = $3)',
    );
  });

  it("multiple conditions ANDed", () => {
    const { sql } = buildWhere(
      order,
      { status: "open", amount: { gt: 5 } },
      ctx,
    );
    expect(sql).toBe('WHERE "status" = $1 AND "amount" > $2');
  });

  it("unknown field rejected", () => {
    expect(() => buildWhere(order, { ghost: 1 }, ctx)).toThrow(SchemaError);
  });

  it("details field cannot be filtered", () => {
    const o = defineObject({
      name: "o",
      fields: [
        { name: "id", type: "string", primary: true },
        { name: "lines", type: "details", target: "line" },
      ],
    });
    expect(() => buildWhere(o, { lines: "x" }, ctx)).toThrow(SchemaError);
  });

  it("rowScope AND injected (params reordered to avoid conflict with filter)", () => {
    const { sql, params } = buildWhere(order, { status: "open" }, ctx, {
      sql: '"owner_id" = $1',
      params: ["u1"],
    });
    expect(sql).toBe('WHERE "status" = $1 AND ("owner_id" = $2)');
    expect(params).toEqual(["open", "u1"]);
  });

  it("rowScope keeps $1 when no filter", () => {
    const { sql, params } = buildWhere(order, undefined, ctx, {
      sql: '"owner_id" = $1',
      params: ["u1"],
    });
    expect(sql).toBe('WHERE ("owner_id" = $1)');
    expect(params).toEqual(["u1"]);
  });
});

describe("buildFindSql / buildColumns / resolvePagination", () => {
  it("full SELECT", () => {
    const opts: FindOptions = {
      filter: { status: "open" },
      sort: [{ field: "amount", dir: "desc" }],
      limit: 10,
      offset: 5,
    };
    const { sql, params } = buildFindSql(order, opts, ctx);
    expect(sql).toContain(
      'SELECT "id", "amount", "status", "tags" FROM "order"',
    );
    expect(sql).toContain('WHERE "status" = $1');
    expect(sql).toContain('ORDER BY "amount" DESC');
    expect(sql).toContain("LIMIT $2 OFFSET $3");
    expect(params).toEqual(["open", 10, 5]);
  });

  it("fields projection whitelist", () => {
    const { sql } = buildFindSql(order, { fields: ["id", "status"] }, ctx);
    expect(sql).toContain('SELECT "id", "status" FROM "order"');
    expect(() => buildColumns(order, ["ghost"], ctx)).toThrow(SchemaError);
  });

  it("pagination defaults and upper bound", () => {
    expect(resolvePagination({})).toEqual({ limit: 100, offset: 0 });
    expect(resolvePagination({ limit: 99999 })).toEqual({
      limit: 1000,
      offset: 0,
    });
    expect(resolvePagination({ offset: -5 })).toEqual({
      limit: 100,
      offset: 0,
    });
  });
});
