/**
 * Creates a scoped agent token. The token goes only into <tokenOut> (created with mode 600, never overwritten);
 * stdout gets the entry to add to the server's agentTokensFile, which holds the token's SHA-256 only.
 *   npx tsx scripts/agent-token.ts <name> <tokenOut> --projects id1,id2|* --scopes read,publish,consume
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { AGENT_SCOPES, tokenSha256 } from "../src/server/auth.js";
import { isReservedActorName, RESERVED_ACTOR_RULE } from "../src/shared/actor.js";
import { idPattern } from "../src/shared/schemas.js";

const [name, out, ...rest] = process.argv.slice(2);
const flag = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const projects = (flag("projects") ?? "").split(",").filter(Boolean);
const scopes = (flag("scopes") ?? "read").split(",").filter(Boolean);
const fail = (m: string) => { console.error(m); process.exit(2); };

if (!name || !out) fail("usage: agent-token.ts <name> <tokenOut> --projects id1,id2|* --scopes read,publish,consume");
if (!/^[A-Za-z0-9._:@-]{1,60}$/.test(name)) fail("name: 1-60 characters of A-Z a-z 0-9 . _ : @ -");
if (isReservedActorName(name)) fail(`name '${name}' ${RESERVED_ACTOR_RULE}; choose another name`);
if (!projects.length || projects.some((p) => p !== "*" && !idPattern.test(p))) fail("--projects: comma-separated project ids, or *");
if (scopes.some((s) => !(AGENT_SCOPES as readonly string[]).includes(s))) fail(`--scopes: any of ${AGENT_SCOPES.join(",")}`);
if (fs.existsSync(out)) fail(`${out} exists; refusing to overwrite a token file`);

const token = crypto.randomBytes(32).toString("base64url");
fs.writeFileSync(out, token + "\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ name, sha256: tokenSha256(token), projects, scopes }, null, 2));
console.error(`token written to ${out}; add the entry above to "tokens" in the server's agentTokensFile and restart`);
