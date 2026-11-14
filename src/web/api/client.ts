import type { ApiError } from "../../shared/api";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: ApiError;
  constructor(status: number, body: ApiError) {
    super(body.message || body.error || `Request failed (${status})`);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
  get fieldErrors(): { fieldId: string; message: string }[] {
    return this.body.fieldErrors ?? [];
  }
}

let unauthorizedHandler: (() => void) | null = null;
/** Called on any 401 outside the auth/session endpoints (the session is re-checked and the login form shown). */
export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn;
}

function isAuthPath(path: string): boolean {
  return path.startsWith("/api/auth/") || path === "/api/session";
}

function isApiError(v: unknown): v is ApiError {
  return !!v && typeof v === "object" && typeof (v as ApiError).message === "string";
}

function fallbackError(status: number, statusText: string): ApiError {
  return { error: `http-${status}`, message: statusText ? `${status} ${statusText}` : `Request failed (${status})` };
}

async function toError(res: Response, path: string): Promise<ApiRequestError> {
  let body: ApiError | null = null;
  try {
    const data: unknown = await res.json();
    if (isApiError(data)) body = data;
  } catch {
    // Non-JSON error body: fall back to the HTTP status line.
  }
  if (res.status === 401 && !isAuthPath(path)) unauthorizedHandler?.();
  return new ApiRequestError(res.status, body ?? fallbackError(res.status, res.statusText));
}

const POST_HEADERS = { "X-PCC-Request": "1", "Content-Type": "application/json", Accept: "application/json" };

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" }, signal });
  if (!res.ok) throw await toError(res, path);
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: POST_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw await toError(res, path);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return clean || "download";
}

export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(header);
  if (star) {
    try {
      return sanitizeFileName(decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")));
    } catch {
      // malformed percent-encoding: try the plain filename parameter instead
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
  const v = plain?.[1] ?? plain?.[2]?.trim();
  return v ? sanitizeFileName(v) : null;
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** POSTs JSON and saves the binary response; returns the file name used. */
export async function apiPostDownload(path: string, body: unknown, fallbackName: string): Promise<string> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { ...POST_HEADERS, Accept: "*/*" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res, path);
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get("Content-Disposition")) ?? fallbackName;
  saveBlob(blob, name);
  return name;
}

/** Multipart POST via XMLHttpRequest so upload progress can be reported (fetch has no upload progress). */
export function uploadMultipart<T>(path: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("X-PCC-Request", "1");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: unknown;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve(data as T);
        return;
      }
      if (xhr.status === 401 && !isAuthPath(path)) unauthorizedHandler?.();
      reject(new ApiRequestError(xhr.status, isApiError(data) ? data : fallbackError(xhr.status, xhr.statusText)));
    };
    xhr.onerror = () => reject(new ApiRequestError(0, { error: "network", message: "Network error during upload" }));
    xhr.onabort = () => reject(new ApiRequestError(0, { error: "aborted", message: "Upload was cancelled" }));
    xhr.send(form);
  });
}

/** 32 hex chars. crypto.randomUUID is missing on plain-http LAN origins, so fall back to getRandomValues. */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const enc = encodeURIComponent;
export const projectApi = (pid: string): string => `/api/projects/${enc(pid)}`;

export interface RecordListParams {
  status: string;
  q: string;
  sort: string;
  limit: number;
}

/** React-query keys. Everything project-scoped starts with ["project", pid, <scope>] so SSE invalidation can target scopes. */
export const qk = {
  session: ["session"] as const,
  projects: ["projects"] as const,
  diagnostics: ["diagnostics"] as const,
  projectDetail: (pid: string) => ["project", pid, "detail"] as const,
  navigation: (pid: string) => ["project", pid, "navigation"] as const,
  records: (pid: string, sectionId: string, params: RecordListParams) => ["project", pid, "records", sectionId, params] as const,
  record: (pid: string, recordId: string) => ["project", pid, "record", recordId] as const,
  progress: (pid: string) => ["project", pid, "progress"] as const,
  activity: (pid: string) => ["project", pid, "activity"] as const,
  attention: (pid: string) => ["project", pid, "attention"] as const,
};
