/** Writes JSON Schema files for the data-file formats to docs/schemas (generated from the zod contracts; do not edit). */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AnyRecord, ProjectManifest, RecurringTemplate, SectionManifest } from "../src/shared/schemas.js";

export const SCHEMAS: Record<string, z.ZodType> = {
  "project.schema.json": ProjectManifest,
  "section.schema.json": SectionManifest,
  "record.schema.json": AnyRecord,
  "recurring-template.schema.json": RecurringTemplate,
};

export function renderSchema(name: string, schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return JSON.stringify({ $id: name, ...json }, null, 2) + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const out = path.resolve("docs/schemas");
  fs.mkdirSync(out, { recursive: true });
  for (const [name, schema] of Object.entries(SCHEMAS)) fs.writeFileSync(path.join(out, name), renderSchema(name, schema));
  console.log(`wrote ${Object.keys(SCHEMAS).length} schemas to docs/schemas`);
}
