import { describe, it, expect } from "../helpers/test.js";
import {
  buildRlsGrantDdl,
  defineObject,
  isSafeRlsRole,
} from "../../src/index.js";

const lead = defineObject({
  name: "lead",
  fields: [{ name: "id", type: "string", primary: true }],
});

describe("isSafeRlsRole — restricted-SQL role name gate", () => {
  it("accepts a plain identifier", () => {
    expect(isSafeRlsRole("weavekit_query")).toBe(true);
  });

  it("rejects reserved SQL keywords", () => {
    for (const name of ["select", "user", "grant", "table", "group"]) {
      expect(isSafeRlsRole(name)).toBe(false);
    }
  });

  it("rejects pseudo-roles and malformed names", () => {
    expect(isSafeRlsRole("public")).toBe(false);
    expect(isSafeRlsRole("WeaveKit")).toBe(false);
    expect(isSafeRlsRole('has"quote')).toBe(false);
    expect(isSafeRlsRole("1abc")).toBe(false);
  });
});

describe("buildRlsGrantDdl — quoted grant", () => {
  it("quotes the object and the role identifier", () => {
    expect(buildRlsGrantDdl(lead, "weavekit_query")).toBe(
      'GRANT SELECT ON "lead" TO "weavekit_query";',
    );
  });
});
