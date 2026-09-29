import { describe, it, expect } from "../helpers/test.js";
import {
  buildFindSql,
  buildWhere,
  defineObject,
  ROW_SCOPE_MARKERS,
} from "../../src/index.js";
import { buildRowScopeFor } from "../../src/core/index.js";

const OWNERSHIP = ROW_SCOPE_MARKERS.OWNERSHIP;

const tag = defineObject({
  name: "tag",
  fields: [
    { name: "id", type: "string", primary: true },
    { name: "label", type: "string" },
    { name: "owner_id", type: "string", [OWNERSHIP]: true },
  ],
  permissions: { reader: { read: "own" }, admin: { read: "all" } },
});
const post = defineObject({
  name: "post",
  fields: [
    { name: "id", type: "string", primary: true },
    { name: "tag_ids", type: "multiRelation", target: "tag" },
  ],
});
const lookup = {
  get: (name: string) => (name === "tag" ? tag : name === "post" ? post : undefined),
};

describe("multiRelation element-level visibility — SQL", () => {
  it("own scope: projection wraps the link subquery with a target EXISTS", () => {
    const { sql, params } = buildFindSql(
      post,
      {},
      { object: "post", lookup, subject: { id: "u1", roles: ["reader"] } },
    );
    expect(sql).toContain(
      'EXISTS (SELECT 1 FROM "tag" tt WHERE tt."id" = l."target_id" AND (tt."owner_id" = $1))',
    );
    expect(params).toEqual(["u1", 100, 0]);
  });

  it("read all: no target scope appended", () => {
    const { sql, params } = buildFindSql(
      post,
      {},
      { object: "post", lookup, subject: { id: "u9", roles: ["admin"] } },
    );
    expect(sql).not.toContain("EXISTS");
    expect(params).toEqual([100, 0]);
  });

  it("no read permission: the projection is NULL (no element leak)", () => {
    const { sql } = buildFindSql(
      post,
      {},
      { object: "post", lookup, subject: { id: "u2", roles: ["nobody"] } },
    );
    expect(sql).toContain('NULL AS "tag_ids"');
  });

  it("no subject: unrestricted (internal path)", () => {
    const { sql } = buildFindSql(post, {}, { object: "post", lookup });
    expect(sql).not.toContain("EXISTS");
  });

  it("filter is scoped to readable targets (contains) and renumbers with paramOffset", () => {
    const { sql, params } = buildWhere(
      post,
      { tag_ids: { contains: ["a"] } },
      { object: "post", lookup, subject: { id: "u1", roles: ["reader"] } },
    );
    expect(sql).toContain('tt."id" = l."target_id"');
    expect(sql).toContain('tt."owner_id" = $1');
    expect(params).toEqual(["u1", ["a"]]);
  });

  it("paramOffset shifts scope placeholders (select params come first)", () => {
    const { sql, params } = buildWhere(
      post,
      { tag_ids: { contains: ["a"] } },
      { object: "post", lookup, subject: { id: "u1", roles: ["reader"] } },
      undefined,
      2,
    );
    expect(sql).toContain('tt."owner_id" = $3');
    expect(sql).toContain("$4");
    expect(params).toEqual(["u1", ["a"]]);
  });
});

describe("buildRowScopeFor — details-child target alias", () => {
  it("qualifies the child parent_id with the target alias", () => {
    const folder = defineObject({
      name: "folder",
      fields: [
        { name: "id", type: "string", primary: true },
        { name: "owner_id", type: "string", [OWNERSHIP]: true },
      ],
    });
    const file = {
      ...defineObject({ name: "file", fields: [{ name: "id", type: "string", primary: true }] }),
      detailsParent: "folder",
    };
    const fragment = buildRowScopeFor(
      { get: (name) => (name === "folder" ? folder : undefined) },
      file,
      "own",
      { id: "u1", roles: ["reader"] },
      ["reader"],
      undefined,
      "tt",
    );
    expect(fragment?.sql).toContain('tt."parent_id"');
    expect(fragment?.sql).toContain('p."owner_id" = $1');
    expect(fragment?.params).toEqual(["u1"]);
  });
});
