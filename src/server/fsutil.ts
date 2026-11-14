/** Filesystem helpers: path containment, atomic JSON writes, safe reads. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export class PathEscapeError extends Error {}

/** True when `child` is `root` or inside it (both absolute, already resolved). */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve a relative path under root, rejecting absolute paths, `..` segments and symlink escapes.
 * Returns the real path when the target exists, or the lexical path when it does not.
 */
export function safeResolve(root: string, rel: string): string {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 1024) throw new PathEscapeError("bad path");
  if (rel.includes("\0")) throw new PathEscapeError("bad path");
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith("\\\\")) throw new PathEscapeError("absolute path");
  if (rel.split(/[\\/]/).some((s) => s === "..")) throw new PathEscapeError("parent segment");
  const realRoot = fs.realpathSync.native(root);
  const target = path.resolve(realRoot, rel);
  if (!isInside(realRoot, target)) throw new PathEscapeError("outside root");
  let real = target;
  try {
    real = fs.realpathSync.native(target);
  } catch {
    // Missing target: check the deepest existing parent instead.
    let p = path.dirname(target);
    while (!fs.existsSync(p) && p !== path.dirname(p)) p = path.dirname(p);
    const rp = fs.realpathSync.native(p);
    if (!isInside(realRoot, rp)) throw new PathEscapeError("symlink escape");
    return target;
  }
  if (!isInside(realRoot, real)) throw new PathEscapeError("symlink escape");
  return real;
}

/** Write JSON via temp file + fsync + rename in the same directory. */
export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  await atomicWriteFile(file, JSON.stringify(data, null, 2) + "\n");
}

export async function atomicWriteFile(file: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fh = await fsp.open(tmp, "wx");
  try {
    await fh.writeFile(content);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await renameWithRetry(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

/** Create a file only if it does not exist (O_EXCL). Returns false when it already exists. */
export async function createExclusive(file: string, data: unknown): Promise<boolean> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    const fh = await fsp.open(file, "wx");
    try {
      await fh.writeFile(JSON.stringify(data, null, 2) + "\n");
      await fh.sync();
    } finally {
      await fh.close();
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/**
 * Create a complete file only if none exists: the content is written and synced to a temp file first, then
 * hard-linked into place (atomic, and fails with EEXIST when the target exists, also across processes). Readers never
 * see a partial file. Falls back to O_EXCL creation on filesystems without hard links. Returns false when it existed.
 */
export async function createExclusiveAtomic(file: string, content: string): Promise<boolean> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fh = await fsp.open(tmp, "wx");
  try {
    await fh.writeFile(content);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.link(tmp, file);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV") throw e;
    return createExclusiveText(file, content);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

async function createExclusiveText(file: string, content: string): Promise<boolean> {
  try {
    const fh = await fsp.open(file, "wx");
    try { await fh.writeFile(content); await fh.sync(); } finally { await fh.close(); }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/** Windows can briefly lock files (AV, indexer); retry renames a few times. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw e;
      last = e;
      await new Promise((r) => setTimeout(r, 15 * (i + 1)));
    }
  }
  throw last;
}

export type JsonRead<T> = { ok: true; value: T; mtimeMs: number } | { ok: false; error: string };

export async function readJson(file: string, maxBytes = 2 * 1024 * 1024): Promise<JsonRead<unknown>> {
  try {
    const st = await fsp.stat(file);
    if (st.size > maxBytes) return { ok: false, error: `file too large (${st.size} bytes)` };
    const text = await fsp.readFile(file, "utf8");
    return { ok: true, value: JSON.parse(text.replace(/^\uFEFF/, "")), mtimeMs: st.mtimeMs };
  } catch (e) {
    const err = e as Error & { code?: string };
    // Never echo fs error messages: they contain absolute paths. JSON syntax errors carry no path.
    if (err.code === "ENOENT") return { ok: false, error: "missing" };
    if (err.code) return { ok: false, error: `cannot read file (${err.code})` };
    return { ok: false, error: err.message.slice(0, 300) };
  }
}

/** Short random id with a prefix, time-ordered (base36 ms + random). */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

export function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const base = path.basename(name).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/^\.+/, "_").trim();
  return (base || "file").slice(0, 150);
}
