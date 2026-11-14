/**
 * Upload storage: <attachmentRoot>/answers/<attachmentId><ext> with a sidecar <attachmentId>.meta.json.
 * Type is decided by extension allowlist and confirmed by content sniffing; client MIME is ignored.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { UploadMeta } from "../shared/schemas.js";
import { atomicWriteJson, newId, readJson, safeResolve, sanitizeFileName } from "./fsutil.js";
import { UPLOAD_SUBDIR, type ProjectState } from "./store.js";
import type { Config } from "./config.js";

export class UploadRejected extends Error {}

export function uploadDir(p: ProjectState): string {
  return path.join(safeResolve(p.dir, p.manifest.allowedAttachmentRoot), UPLOAD_SUBDIR);
}

export function mimeForName(cfg: Config, name: string): string | null {
  const ext = path.extname(name).toLowerCase();
  for (const [mime, exts] of Object.entries(cfg.allowedUploadTypes)) if (exts.includes(ext)) return mime;
  return null;
}

/** Check leading bytes match the declared type. */
export function sniffOk(mime: string, head: Buffer): boolean {
  const starts = (sig: number[], off = 0) => sig.every((b, i) => head[off + i] === b);
  switch (mime) {
    case "image/png": return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg": return starts([0xff, 0xd8, 0xff]);
    case "image/gif": return starts([0x47, 0x49, 0x46, 0x38]);
    case "image/webp": return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
    case "application/pdf": return starts([0x25, 0x50, 0x44, 0x46]);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return starts([0x50, 0x4b, 0x03, 0x04]);
    case "text/markdown":
    case "text/plain":
      return !head.includes(0);
    default:
      return false;
  }
}

/** Stream one uploaded file to disk with size limit, hash and type checks. */
export async function storeUpload(
  cfg: Config,
  p: ProjectState,
  stream: Readable & { truncated?: boolean },
  originalName: string,
  user: string,
  questionId?: string,
): Promise<UploadMeta> {
  const clean = sanitizeFileName(originalName);
  const mime = mimeForName(cfg, clean);
  if (!mime) {
    stream.resume();
    throw new UploadRejected(`${clean}: file type not allowed`);
  }
  const dir = uploadDir(p);
  await fsp.mkdir(dir, { recursive: true });
  const attachmentId = newId("UPL");
  const ext = path.extname(clean).toLowerCase();
  const storedName = `${attachmentId}${ext}`;
  const tmp = path.join(dir, `.${storedName}.part`);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  let head = Buffer.alloc(0);
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > cfg.uploads.maxBytes) return cb(new UploadRejected(`${clean}: larger than ${cfg.uploads.maxBytes} bytes`));
      if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(stream, meter, fs.createWriteStream(tmp, { flags: "wx" }));
    if (stream.truncated) throw new UploadRejected(`${clean}: larger than ${cfg.uploads.maxBytes} bytes`);
    if (bytes === 0) throw new UploadRejected(`${clean}: empty file`);
    const sniffHead = mime.startsWith("text/") ? (await fsp.readFile(tmp)).subarray(0, 8192) : head;
    if (!sniffOk(mime, sniffHead)) throw new UploadRejected(`${clean}: content does not match ${mime}`);
    await fsp.rename(tmp, path.join(dir, storedName));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    if (e instanceof UploadRejected) throw e;
    if ((e as Error).message?.includes("larger than")) throw new UploadRejected((e as Error).message);
    throw e;
  }
  const meta: UploadMeta = {
    schemaVersion: 1,
    attachmentId,
    storedName,
    originalName: clean,
    mimeType: mime,
    bytes,
    sha256: hash.digest("hex"),
    uploadedAt: new Date().toISOString(),
    uploadedBy: user,
    questionId,
  };
  await atomicWriteJson(path.join(dir, `${attachmentId}.meta.json`), meta);
  p.uploads.set(attachmentId, meta);
  return meta;
}

export async function markUploadsUsed(p: ProjectState, ids: string[], answerId: string): Promise<void> {
  const dir = uploadDir(p);
  for (const id of ids) {
    const file = path.join(dir, `${id}.meta.json`);
    const raw = await readJson(file);
    if (!raw.ok) continue;
    const meta = UploadMeta.parse(raw.value);
    const next = { ...meta, answerId };
    await atomicWriteJson(file, next);
    p.uploads.set(id, next);
  }
}
