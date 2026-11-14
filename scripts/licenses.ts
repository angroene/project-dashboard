/**
 * Third-party license report for the packages that ship with the dashboard.
 *   npx tsx scripts/licenses.ts                       print the report to stdout
 *   npx tsx scripts/licenses.ts --out docs/THIRD_PARTY_LICENSES.md   write it (keeps the hand-written review notes)
 *
 * Scope:
 *   1. production dependencies: `npm ls --omit=dev --all --json` (what the server needs at runtime)
 *   2. web bundle dependencies: react, react-dom, @tanstack/react-query and react-markdown plus their trees.
 *      They are listed under devDependencies because Vite bundles them into dist/web, but they are redistributed.
 * Reads the license field of each installed package.json; also reports NOTICE files shipped by packages.
 * Needs `npm ci` first. Read-only: modifies nothing except the --out file.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WEB_ROOTS = ["react", "react-dom", "@tanstack/react-query", "react-markdown"];
const PERMISSIVE = new Set([
  "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "Python-2.0", "MIT-0", "Zlib",
]);
const NOTES_BEGIN = "<!-- review-notes:begin -->";
const NOTES_END = "<!-- review-notes:end -->";

interface TreeNode { version?: string; extraneous?: boolean; dependencies?: Record<string, TreeNode>; }
interface Pkg { name: string; version: string; license: string; permissive: boolean; unknown: boolean; notice: string[]; dir: string; }

const root = process.cwd();
const notInstalled = new Set<string>();

function npmLs(args: string[]): TreeNode {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  let out: string;
  try {
    out = execFileSync(npm, ["ls", ...args, "--all", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" });
  } catch (e) {
    // npm ls exits non-zero for tree problems but still prints the tree.
    out = (e as { stdout?: string }).stdout ?? "";
    if (!out) throw e;
  }
  return JSON.parse(out) as TreeNode;
}

/** Resolve an installed package directory the way Node does: nearest node_modules walking up from the parent. */
function resolveDir(name: string, fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    const cand = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(cand, "package.json"))) return cand;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function collect(tree: TreeNode, parentDir: string, into: Map<string, Pkg>): void {
  for (const [name, node] of Object.entries(tree.dependencies ?? {})) {
    if (node.extraneous) continue; // stray installs from a different package.json state are not part of the tree
    const dir = resolveDir(name, parentDir);
    if (dir) {
      const pkg = readPkg(dir);
      if (!into.has(`${pkg.name}@${pkg.version}`)) into.set(`${pkg.name}@${pkg.version}`, pkg);
      collect(node, dir, into);
    } else {
      notInstalled.add(name); // optional platform-specific packages for other OSes are legitimately absent
    }
  }
}

function licenseOf(j: Record<string, unknown>): string {
  const l = j.license ?? j.licenses;
  if (typeof l === "string") return l;
  if (l && !Array.isArray(l) && typeof (l as { type?: string }).type === "string") return (l as { type: string }).type;
  if (Array.isArray(l)) return l.map((x) => (typeof x === "string" ? x : (x as { type?: string }).type ?? "?")).join(" OR ");
  return "";
}

/** SPDX expression check: OR needs one permissive alternative, AND needs all. */
function isPermissive(expr: string): boolean {
  const e = expr.replace(/[()]/g, " ").trim();
  if (!e) return false;
  const orParts = e.split(/\s+OR\s+/i);
  return orParts.some((part) => part.split(/\s+AND\s+/i).every((id) => PERMISSIVE.has(id.trim())));
}

function readPkg(dir: string): Pkg {
  const j = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  const license = licenseOf(j) || "UNKNOWN";
  const notice = fs.readdirSync(dir).filter((f) => /^NOTICE(\.|$)/i.test(f));
  return {
    name: String(j.name), version: String(j.version), license,
    permissive: license !== "UNKNOWN" && isPermissive(license), unknown: license === "UNKNOWN" || /^SEE LICENSE/i.test(license),
    notice, dir,
  };
}

function gather(tree: TreeNode): Map<string, Pkg> {
  const m = new Map<string, Pkg>();
  collect(tree, root, m);
  return m;
}

const prod = gather(npmLs(["--omit=dev"]));
const full = npmLs([]);
const webTree: TreeNode = { dependencies: Object.fromEntries(WEB_ROOTS.filter((n) => full.dependencies?.[n]).map((n) => [n, full.dependencies![n]])) };
const web = gather(webTree);
const missingRoots = WEB_ROOTS.filter((n) => !full.dependencies?.[n]);
if (missingRoots.length) console.error(`warning: web root(s) not installed: ${missingRoots.join(", ")}`);

const sorted = (m: Map<string, Pkg>) => [...m.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const all = new Map<string, Pkg>([...prod, ...web]);
const flagged = sorted(all).filter((p) => !p.permissive);
const notices = sorted(all).filter((p) => p.notice.length);

const table = (m: Map<string, Pkg>) =>
  ["| Package | Version | License | NOTICE file |", "|---|---|---|---|",
    ...sorted(m).map((p) => `| ${p.name} | ${p.version} | ${p.license}${p.permissive ? "" : " **(review)**"} | ${p.notice.length ? p.notice.join(", ") : ""} |`)].join("\n");

const counts = new Map<string, number>();
for (const p of all.values()) counts.set(p.license, (counts.get(p.license) ?? 0) + 1);
const countLines = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `- ${l}: ${n}`).join("\n");

const defaultNotes = `${NOTES_BEGIN}\n_No review notes recorded yet._\n${NOTES_END}`;
let notes = defaultNotes;
const outIdx = process.argv.indexOf("--out");
const outFile = outIdx >= 0 ? process.argv[outIdx + 1] : null;
if (outFile && fs.existsSync(outFile)) {
  const old = fs.readFileSync(outFile, "utf8");
  const a = old.indexOf(NOTES_BEGIN), b = old.indexOf(NOTES_END);
  if (a >= 0 && b > a) notes = old.slice(a, b + NOTES_END.length);
}

const report = `# Third-party licenses

Generated by \`npx tsx scripts/licenses.ts --out docs/THIRD_PARTY_LICENSES.md\`. It reads the \`license\` field of every
installed \`package.json\` and is only as accurate as that metadata. It is a dependency review aid, not legal advice.

Scope: (1) production dependencies, from \`npm ls --omit=dev --all\`; (2) the web bundle's runtime libraries
(${WEB_ROOTS.join(", ")} and their trees), which are bundled into \`dist/web\` even though they are listed as devDependencies.
Build and test tooling (vite, vitest, typescript, tsx, playwright-core, type packages) is not redistributed and is not listed.

## Summary

- Production dependency packages: ${prod.size}
- Web bundle dependency packages: ${web.size}
- Distinct packages overall (name and version): ${all.size}
- Packages needing review (non-permissive or unknown license): ${flagged.length}
- Packages shipping a NOTICE file: ${notices.length}
- Optional packages not installed on this platform (not checked): ${notInstalled.size}

Licenses by package count:

${countLines}

## Needs review

${flagged.length ? sorted(new Map(flagged.map((p) => [`${p.name}@${p.version}`, p]))).map((p) => `- ${p.name}@${p.version}: ${p.license}`).join("\n") : "None. Every package declares a license from the permissive allowlist (" + [...PERMISSIVE].join(", ") + ")."}

## Packages with a NOTICE file

${notices.length ? notices.map((p) => `- ${p.name}@${p.version}: ${p.notice.join(", ")}`).join("\n") : "None."}

## Review notes

${notes}

## Production dependencies

${table(prod)}

## Web bundle dependencies

${table(web)}
`;

if (outFile) {
  fs.writeFileSync(outFile, report);
  console.log(`wrote ${outFile}: ${all.size} packages, ${flagged.length} need review, ${notices.length} with NOTICE`);
} else {
  console.log(report);
}
