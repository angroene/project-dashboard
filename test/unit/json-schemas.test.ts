import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderSchema, SCHEMAS } from "../../scripts/gen-schemas.js";

describe("published JSON Schemas", () => {
  it.each(Object.keys(SCHEMAS))("docs/schemas/%s matches the contract (run npm run schemas after changing it)", (name) => {
    const file = fs.readFileSync(path.resolve("docs/schemas", name), "utf8").replace(/\r\n/g, "\n");
    expect(file).toBe(renderSchema(name, SCHEMAS[name]));
  });
});
