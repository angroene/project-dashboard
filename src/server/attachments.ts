/** Resolve attachment ids (record-declared files and uploads) to files inside permitted roots. */
import fs from "node:fs";
import path from "node:path";
import type { AttachmentRef } from "../shared/api.js";
import { safeResolve, sanitizeFileName } from "./fsutil.js";
import type { ProjectState } from "./store.js";
import { uploadDir } from "./uploads.js";

const EXT_MIME: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain", ".log": "text/plain",
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json", ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

export interface ResolvedAttachment {
  id: string;
  recordId?: string;
  title: string;
  fileName: string;
  mimeType: string;
  file: string | null;
  bytes: number | null;
  reason?: string;
}

export function resolveAttachment(p: ProjectState, id: string): ResolvedAttachment | null {
  const up = p.uploads.get(id);
  if (up) {
    // Type comes from the stored extension (server allowlist), never from the metadata file.
    const mimeType = EXT_MIME[path.extname(up.storedName).toLowerCase()] ?? "application/octet-stream";
    const base = { id, title: up.originalName, fileName: up.originalName, mimeType };
    try {
      const file = safeResolve(uploadDir(p), up.storedName);
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (!st || !st.isFile()) return { ...base, file: null, bytes: null, reason: "file missing" };
      return { ...base, file, bytes: st.size };
    } catch {
      return { ...base, file: null, bytes: null, reason: "path rejected" };
    }
  }
  const reg = p.attachments.get(id);
  if (!reg) return null;
  const a = reg.att;
  const fileName = sanitizeFileName(path.basename(a.path));
  const mimeType = a.mimeType ?? EXT_MIME[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
  const base: ResolvedAttachment = { id, recordId: reg.recordId, title: a.title ?? fileName, fileName, mimeType, file: null, bytes: null };
  const rootRel = a.root === "attachments" ? p.manifest.allowedAttachmentRoot : p.manifest.artifactRoots.includes(a.root) ? a.root : null;
  if (!rootRel) return { ...base, reason: `root '${a.root}' is not declared by the project` };
  try {
    const rootDir = safeResolve(p.dir, rootRel);
    if (!fs.existsSync(rootDir)) return { ...base, reason: "attachment root missing" };
    const file = safeResolve(rootDir, a.path);
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return { ...base, reason: "file missing" };
    return { ...base, file, bytes: st.size };
  } catch (e) {
    return { ...base, reason: `path rejected: ${(e as Error).message}` };
  }
}

export function attachmentRef(projectId: string, r: ResolvedAttachment): AttachmentRef {
  return {
    id: r.id,
    title: r.title,
    fileName: r.fileName,
    mimeType: r.mimeType,
    bytes: r.bytes,
    available: !!r.file,
    url: `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(r.id)}`,
  };
}

/** Content types the browser may render inline; everything else is forced to download. */
export function inlineSafe(mime: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"].includes(mime);
}
