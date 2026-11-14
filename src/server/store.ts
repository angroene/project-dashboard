/**
 * In-memory, rebuildable index over the file-based data root.
 * Files stay authoritative; the index only caches what lists, counts and navigation need.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  ActivityEvent, AnyRecord, ALLOWED_CHILDREN, MAX_SECTION_DEPTH, ProgressFile, ProjectManifest, ReadState,
  SectionManifest, UploadMeta, PROCESSING_STATES, type Action, type DisplayType, type ProcessingState,
  type RecordAttachment, type RecordType,
} from "../shared/schemas.js";
import type {
  Diagnostic, InvalidateEvent, NavNode, ProgressSummary, ProjectCard, QuestionUiState, RecordSummary,
} from "../shared/api.js";
import { atomicWriteJson, isInside, readJson, safeResolve } from "./fsutil.js";
import { statusInfo, workflowFor } from "../shared/workflow.js";
import type { Config } from "./config.js";

export interface SectionState {
  manifest: SectionManifest;
  dir: string;
  relDir: string;
  parentId: string | null;
  depth: number;
  childIds: string[];
  recordIds: string[];
}

export interface RecordEntry {
  id: string;
  recordType: RecordType;
  sectionId: string;
  file: string;
  title: string;
  summary: string;
  status: string;
  statusLabel?: string;
  priority: string;
  updatedAt: string;
  order?: number;
  percent?: number | null;
  notifyUser: boolean;
  actions: Action[];
  attachments: RecordAttachment[];
  question?: {
    requiresResponse: boolean;
    revision: number;
    answerType?: string;
    dueAt?: string;
    taskId?: string;
  };
}

export interface ClaimEntry {
  answerId: string;
  questionId: string;
  revision: number;
  submittedAt?: string;
}

export interface ProjectState {
  key: string;
  dir: string;
  manifest: ProjectManifest;
  progress: ProgressSummary;
  progressBreakdown: ProgressFile["breakdown"];
  sections: Map<string, SectionState>;
  rootIds: string[];
  rootChildType: DisplayType | null;
  records: Map<string, RecordEntry>;
  attachments: Map<string, { recordId: string; att: RecordAttachment }>;
  uploads: Map<string, UploadMeta>;
  claims: Map<string, ClaimEntry>;
  answerStates: Map<string, ProcessingState>;
  activity: ActivityEvent[];
  readState: ReadState;
  diagnostics: Diagnostic[];
  indexMs: number;
  signature: string;
}

export interface BrokenProject {
  key: string;
  dir: string;
  reason: string;
}

const PROJECT_FILE = "project.json";
const SECTION_FILE = "section.json";
export const COMM_DIR = "communications";
export const ANSWERS_DIR = path.join(COMM_DIR, "answers");
export const CLAIMS_DIR = path.join(COMM_DIR, "claims");
export const UPLOAD_SUBDIR = "answers";
const USER_STATE_DIR = "user-state";

export const claimKey = (questionId: string, revision: number) => `${questionId}@r${revision}`;

function zodMessage(e: unknown): string {
  const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (!issues) return String(e).slice(0, 300);
  return issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Serialise async work per key (e.g. per project read-state file). */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }
}

export class Store extends EventEmitter {
  readonly projects = new Map<string, ProjectState>();
  broken: BrokenProject[] = [];
  globalDiagnostics: Diagnostic[] = [];
  indexedAt = new Date().toISOString();
  readonly mutex = new KeyedMutex();
  private cardCache = new Map<string, { card: ProjectCard; at: number; state: ProjectState }>();
  /** Project root → its watcher, or null when watching that root failed. */
  private watchers = new Map<string, fs.FSWatcher | null>();
  private watching = false;
  private pending = new Map<string, Set<string>>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reloading = new KeyedMutex();

  constructor(readonly cfg: Config) {
    super();
    this.setMaxListeners(200);
  }

  // ------------------------------------------------------------ discovery --
  projectDirs(): string[] {
    const dirs: string[] = [];
    const base = path.join(this.cfg.dataRoot, "projects");
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base, { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith(".")) dirs.push(path.join(base, d.name));
      }
    }
    for (const extra of this.cfg.extraProjectRoots) if (fs.existsSync(extra)) dirs.push(extra);
    return dirs.sort();
  }

  async init(): Promise<void> {
    const t0 = performance.now();
    this.projects.clear();
    this.broken = [];
    this.globalDiagnostics = [];
    if (!fs.existsSync(this.cfg.dataRoot)) {
      this.globalDiagnostics.push({ level: "error", message: "data root not found (check dataRoot in the server config)" });
    }
    for (const dir of this.projectDirs()) await this.loadProjectDir(dir);
    this.indexedAt = new Date().toISOString();
    this.emit("indexed", performance.now() - t0);
  }

  private async loadProjectDir(dir: string): Promise<void> {
    const key = path.basename(dir);
    const res = await loadProject(dir);
    if (!("reason" in res)) await loadReadStateFor(res, this.cfg.auth.user);
    // Everything below is synchronous: requests never observe the project as missing mid-reload.
    for (const [id, p] of this.projects) if (p.dir === res.dir && ("reason" in res || id !== res.manifest.id)) this.projects.delete(id);
    this.broken = this.broken.filter((b) => b.dir !== res.dir);
    if ("reason" in res) {
      this.broken.push({ key, dir: res.dir, reason: res.reason });
      return;
    }
    const clash = this.projects.get(res.manifest.id);
    if (clash && clash.dir !== res.dir) {
      this.broken.push({ key, dir: res.dir, reason: `duplicate project id '${res.manifest.id}' (already used by ${path.basename(clash.dir)})` });
      return;
    }
    this.projects.set(res.manifest.id, res);
  }

  /** Re-read a whole project (or discover a new/removed one). */
  async reloadDir(dir: string): Promise<void> {
    await this.reloading.run(dir, async () => {
      if (!fs.existsSync(path.join(dir, PROJECT_FILE)) && !fs.existsSync(dir)) {
        for (const [id, p] of this.projects) if (p.dir === dir) this.projects.delete(id);
        this.broken = this.broken.filter((b) => b.dir !== dir);
      } else {
        await this.loadProjectDir(dir);
      }
      this.indexedAt = new Date().toISOString();
    });
  }

  get(projectId: string): ProjectState | undefined {
    return this.projects.get(projectId);
  }

  diagnostics(): Diagnostic[] {
    const out = [...this.globalDiagnostics];
    for (const b of this.broken) out.push({ level: "error", projectId: b.key, path: `${b.key}/project.json`, message: b.reason });
    for (const p of this.projects.values()) out.push(...p.diagnostics);
    return out;
  }

  // ---------------------------------------------------------- derived data --
  questionUiState(p: ProjectState, r: RecordEntry): QuestionUiState | undefined {
    if (r.recordType !== "question" || !r.question) return undefined;
    if (r.status === "closed" || r.status === "withdrawn") return "closed";
    if (!r.question.requiresResponse) return "informational";
    if (r.status === "processed") return "processed";
    const claim = p.claims.get(claimKey(r.id, r.question.revision));
    if (claim) {
      const st = p.answerStates.get(claim.answerId) ?? "pending";
      return st === "pending" ? "submitted" : st;
    }
    if (r.status === "answered") return "answered";
    return "needs-response";
  }

  isUnread(p: ProjectState, r: RecordEntry): boolean {
    if (!r.notifyUser) return false;
    const seen = p.readState.seen[`record:${r.id}`];
    return !seen || Date.parse(seen) < Date.parse(r.updatedAt);
  }

  isActivityUnread(p: ProjectState, e: ActivityEvent): boolean {
    return !p.readState.seen[`activity:${e.id}`];
  }

  summary(p: ProjectState, r: RecordEntry): RecordSummary {
    const info = statusInfo(p.manifest, r.recordType, r.status);
    const s: RecordSummary = {
      id: r.id,
      recordType: r.recordType,
      sectionId: r.sectionId,
      title: r.title,
      summary: r.summary,
      status: r.status,
      statusLabel: r.statusLabel ?? info.label,
      statusCategory: info.category,
      statusTone: info.tone,
      priority: r.priority,
      updatedAt: r.updatedAt,
      order: r.order,
      percent: r.percent,
      attachmentCount: r.attachments.length,
      unread: this.isUnread(p, r),
      actions: r.actions,
    };
    if (r.question) {
      const claim = p.claims.get(claimKey(r.id, r.question.revision));
      s.question = {
        uiState: this.questionUiState(p, r)!,
        revision: r.question.revision,
        requiresResponse: r.question.requiresResponse,
        answerType: r.question.answerType as never,
        answerId: claim?.answerId,
        answeredAt: claim?.submittedAt,
        dueAt: r.question.dueAt,
      };
    }
    return s;
  }

  /**
   * Landing-card counts are cached per project and dropped on every invalidate event for that project
   * (all writers emit one), so GET /api/projects is O(projects). 60 s TTL keeps time-based "stale" fresh.
   */
  card(p: ProjectState): ProjectCard {
    const hit = this.cardCache.get(p.manifest.id);
    if (hit && hit.state === p && Date.now() - hit.at < 60_000) return hit.card;
    const card = this.computeCard(p);
    this.cardCache.set(p.manifest.id, { card, at: Date.now(), state: p });
    return card;
  }

  private computeCard(p: ProjectState): ProjectCard {
    let awaitingResponse = 0, unread = 0, blocked = 0, active = 0;
    for (const r of p.records.values()) {
      if (this.questionUiState(p, r) === "needs-response") awaitingResponse++;
      if (this.isUnread(p, r)) unread++;
      if (r.recordType !== "question") {
        const cat = statusInfo(p.manifest, r.recordType, r.status).category;
        if (cat === "blocked") blocked++;
        else if (cat === "active") active++;
      }
    }
    for (const e of p.activity) if (this.isActivityUnread(p, e)) unread++;
    let awaitingPickup = 0;
    for (const st of p.answerStates.values()) if (st === "pending" || st === "processing") awaitingPickup++;
    return {
      id: p.manifest.id,
      displayName: p.manifest.displayName,
      description: p.manifest.description,
      order: p.manifest.order,
      accent: p.manifest.theme.accent,
      available: true,
      progress: p.progress,
      awaitingResponse,
      awaitingPickup,
      unreadUpdates: unread,
      blocked,
      active,
    };
  }

  brokenCard(b: BrokenProject): ProjectCard {
    return {
      id: b.key,
      displayName: b.key,
      description: "",
      order: 10_000,
      accent: "slate",
      available: false,
      unavailableReason: b.reason,
      progress: { overallPercent: null, label: "Overall progress", method: "", stale: false },
      awaitingResponse: 0,
      awaitingPickup: 0,
      unreadUpdates: 0,
      blocked: 0,
      active: 0,
    };
  }

  /** Records of a section and all its descendant sections. */
  sectionRecordIds(p: ProjectState, sectionId: string): string[] {
    const s = p.sections.get(sectionId);
    if (!s) return [];
    return [...s.recordIds, ...s.childIds.flatMap((c) => this.sectionRecordIds(p, c))];
  }

  navigation(p: ProjectState): NavNode[] {
    const build = (id: string): NavNode => {
      const s = p.sections.get(id)!;
      const m = s.manifest;
      const ids = this.sectionRecordIds(p, id);
      let awaiting = 0, unread = 0;
      for (const rid of ids) {
        const r = p.records.get(rid);
        if (!r) continue;
        if (this.questionUiState(p, r) === "needs-response") awaiting++;
        if (this.isUnread(p, r)) unread++;
      }
      return {
        id: m.id,
        displayType: m.displayType,
        title: m.title,
        description: m.description,
        icon: m.icon,
        order: m.order,
        defaultOpen: m.defaultOpen,
        views: m.views,
        actions: m.actions,
        filters: m.filters,
        pageSize: m.pageSize,
        counts: { records: ids.length, awaitingResponse: awaiting, unread },
        children: s.childIds.map(build),
      };
    };
    return p.rootIds.map(build);
  }

  // ------------------------------------------------------------ mutations --
  async saveReadState(p: ProjectState, mutate: (seen: Record<string, string>) => number): Promise<number> {
    return this.mutex.run(`read:${p.manifest.id}`, async () => {
      const file = readStateFile(p.dir, this.cfg.auth.user);
      const cur = await readJson(file);
      const base = cur.ok ? ReadState.safeParse(cur.value) : null;
      const seen = { ...(base?.success ? base.data.seen : {}), ...p.readState.seen };
      const n = mutate(seen);
      const next: ReadState = { schemaVersion: 1, user: this.cfg.auth.user, seen };
      await atomicWriteJson(file, next);
      p.readState = next;
      this.cardCache.delete(p.manifest.id);
      return n;
    });
  }

  /** Re-read the answer queue/claims index of one project (cheap: directory listings + small claim files). */
  async reloadAnswers(p: ProjectState): Promise<void> {
    const { claims, states } = await loadAnswerIndex(p.dir, p.diagnostics);
    p.claims = claims;
    p.answerStates = states;
  }

  async reloadUploads(p: ProjectState): Promise<void> {
    p.uploads = await loadUploads(p);
  }

  invalidate(ev: InvalidateEvent): void {
    if (ev.projectId) this.cardCache.delete(ev.projectId);
    else this.cardCache.clear();
    this.emit("invalidate", ev);
  }

  // ----------------------------------------------------- watching/reconcile --
  startWatching(): void {
    this.watching = this.cfg.watch;
    this.watchNewRoots();
    if (this.cfg.reconcileSeconds > 0) {
      this.reconcileTimer = setInterval(() => void this.reconcile(), this.cfg.reconcileSeconds * 1000);
      this.reconcileTimer.unref();
    }
  }

  /**
   * Attaches a recursive watcher to every project root that exists and has none yet. Called at start and on every
   * reconciliation, so a root created after startup (e.g. `projects/` on a fresh data volume) is watched from then on.
   * A root whose watcher could not be created is not retried; reconciliation covers it.
   */
  private watchNewRoots(): void {
    if (!this.watching) return;
    const base = path.join(this.cfg.dataRoot, "projects");
    for (const root of [base, ...this.cfg.extraProjectRoots]) {
      if (this.watchers.has(root) || !fs.existsSync(root)) continue;
      try {
        const w = fs.watch(root, { recursive: true }, (_ev, file) => {
          if (!file) return this.queueChange(root, "");
          this.queueChange(root, file.toString());
        });
        w.on("error", (e) => this.globalDiagnostics.push({ level: "warning", message: `file watcher error (${(e as NodeJS.ErrnoException).code ?? "unknown"}); relying on reconciliation` }));
        this.watchers.set(root, w);
      } catch (e) {
        this.watchers.set(root, null);
        this.globalDiagnostics.push({ level: "warning", message: `file watching unavailable (${(e as NodeJS.ErrnoException).code ?? "unknown"}); relying on reconciliation` });
      }
    }
  }

  stop(): void {
    this.watching = false;
    for (const w of this.watchers.values()) w?.close();
    this.watchers.clear();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  private queueChange(root: string, rel: string): void {
    const base = path.join(this.cfg.dataRoot, "projects");
    let projectDir: string;
    let inner: string;
    if (root === base) {
      const parts = rel.split(/[\\/]/);
      if (!parts[0]) return;
      projectDir = path.join(base, parts[0]);
      inner = parts.slice(1).join("/");
    } else {
      projectDir = root;
      inner = rel.replace(/\\/g, "/");
    }
    if (/(^|\/)\.[^/]*\.tmp$/.test(inner)) return; // our own temp files
    if (inner.startsWith(`${USER_STATE_DIR}/`)) return; // our own read-state writes
    const set = this.pending.get(projectDir) ?? new Set<string>();
    set.add(inner);
    this.pending.set(projectDir, set);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flushChanges(), 200);
  }

  private async flushChanges(): Promise<void> {
    const batch = this.pending;
    this.pending = new Map();
    for (const [dir, files] of batch) {
      try {
        await this.applyChanges(dir, [...files]);
      } catch (e) {
        this.globalDiagnostics.push({ level: "warning", message: `reindex failed for ${path.basename(dir)}: ${(e as NodeJS.ErrnoException).code ?? "error"}` });
      }
    }
  }

  /** Decide the cheapest correct refresh for a set of changed paths in one project dir. */
  async applyChanges(dir: string, files: string[]): Promise<void> {
    const p = [...this.projects.values()].find((x) => x.dir === dir || x.dir === safeReal(dir));
    if (!p) {
      await this.reloadDir(dir);
      this.invalidate({ projectId: null, scopes: ["projects"] });
      return;
    }
    const id = p.manifest.id;
    // Classify every changed path. A batch made only of data files (answers, activity, progress, uploads, records) is
    // refreshed in place on the live project object; only structural changes (manifests, sections, unknown paths)
    // rebuild the project. A rebuild swaps the object, which briefly hides writes made through the old one.
    const under = (f: string, rel: string) => { const r = rel.replace(/\\/g, "/"); return f === r || f.startsWith(`${r}/`); };
    let answers = false, activity = false, progress = false, uploads = false, structural = false;
    const recordFiles: string[] = [];
    for (const f of files) {
      if (under(f, COMM_DIR)) answers = true;
      else if (under(f, p.manifest.activityDir)) activity = true;
      else if (f === p.manifest.progressFile.replace(/\\/g, "/")) progress = true;
      else if (under(f, p.manifest.allowedAttachmentRoot)) uploads = true;
      else if (/\/records\/[^/]+\.json$/.test(f)) recordFiles.push(f);
      else structural = true;
    }
    if (!structural && recordFiles.length <= 50) {
      const changed: string[] = [];
      let ok = true;
      for (const f of recordFiles) {
        const res = await refreshRecordFile(p, path.join(p.dir, f));
        if (res === "structural") { ok = false; break; }
        if (res) changed.push(res);
      }
      if (ok) {
        const scopes = new Set<InvalidateEvent["scopes"][number]>();
        if (answers) { await this.reloadAnswers(p); for (const s of ["answers", "records", "projects", "navigation"] as const) scopes.add(s); }
        if (activity) { p.activity = await loadActivity(p); scopes.add("activity").add("projects"); }
        if (progress) { await loadProgressInto(p); scopes.add("progress").add("projects"); }
        if (uploads) { await this.reloadUploads(p); scopes.add("records"); }
        if (recordFiles.length) {
          p.signature = await projectSignature(p.dir, p.manifest);
          for (const s of ["records", "navigation", "projects"] as const) scopes.add(s);
        }
        this.invalidate({ projectId: id, scopes: [...scopes], ...(recordFiles.length ? { recordIds: changed } : {}) });
        return;
      }
    }
    await this.reloadDir(p.dir);
    this.invalidate({ projectId: id, scopes: ["projects", "navigation", "records", "progress", "activity", "answers"] });
  }

  /** Safety net for missed watcher events: compare a stat-only signature per project. */
  async reconcile(): Promise<void> {
    this.watchNewRoots();
    const dirs = this.projectDirs();
    const known = new Set([...this.projects.values()].map((p) => p.dir).concat(this.broken.map((b) => b.dir)));
    let changed = false;
    for (const d of dirs) {
      const real = safeReal(d);
      if (!known.has(real)) { await this.reloadDir(d); changed = true; }
    }
    for (const p of [...this.projects.values()]) {
      if (!fs.existsSync(p.dir)) { this.projects.delete(p.manifest.id); changed = true; continue; }
      const sig = await projectSignature(p.dir, p.manifest);
      if (sig !== p.signature) {
        await this.reloadDir(p.dir);
        this.invalidate({ projectId: p.manifest.id, scopes: ["projects", "navigation", "records", "progress", "activity", "answers"] });
      }
    }
    for (const b of [...this.broken]) {
      await this.reloadDir(b.dir);
      if (this.get(path.basename(b.dir)) || [...this.projects.values()].some((x) => x.dir === b.dir)) changed = true;
    }
    if (changed) this.invalidate({ projectId: null, scopes: ["projects"] });
  }
}

function safeReal(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

export function readStateFile(projectDir: string, user: string): string {
  const safeUser = user.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "operator";
  return path.join(projectDir, USER_STATE_DIR, `${safeUser}.json`);
}

// ------------------------------------------------------------- loaders -----
export async function loadProject(dirIn: string): Promise<ProjectState | BrokenProject> {
  const t0 = performance.now();
  const key = path.basename(dirIn);
  let dir: string;
  try { dir = fs.realpathSync.native(dirIn); } catch { return { key, dir: dirIn, reason: "project folder not readable" }; }
  const raw = await readJson(path.join(dir, PROJECT_FILE), 256 * 1024);
  if (!raw.ok) return { key, dir, reason: `project.json: ${raw.error}` };
  const parsed = ProjectManifest.safeParse(raw.value);
  if (!parsed.success) return { key, dir, reason: `project.json invalid: ${zodMessage(parsed.error)}` };
  const manifest = parsed.data;
  // Always push to p.diagnostics (loaders replace that array when they drop stale entries).
  const diag = (level: Diagnostic["level"], file: string, message: string) =>
    p.diagnostics.push({ level, projectId: manifest.id, path: path.relative(dir, file) || ".", message });

  const p: ProjectState = {
    key, dir, manifest,
    progress: { overallPercent: null, label: "Overall progress", method: "", stale: false },
    progressBreakdown: [],
    sections: new Map(), rootIds: [], rootChildType: null,
    records: new Map(), attachments: new Map(), uploads: new Map(),
    claims: new Map(), answerStates: new Map(), activity: [],
    readState: { schemaVersion: 1, user: "operator", seen: {} },
    diagnostics: [], indexMs: 0, signature: "",
  };

  // Validate every declared root stays inside the project.
  for (const rel of [manifest.rootSection, manifest.progressFile, manifest.allowedAttachmentRoot, manifest.activityDir, ...manifest.artifactRoots]) {
    try { safeResolve(dir, rel); } catch (e) { return { key, dir, reason: `project.json path '${rel}' rejected: ${(e as Error).message}` }; }
  }

  await loadProgressInto(p);

  // Sections: walk folders containing section.json.
  const sectionRoot = safeResolve(dir, manifest.rootSection);
  const walk = async (folder: string, parentId: string | null, parentType: "root" | DisplayType, depth: number): Promise<string[]> => {
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(folder, { withFileTypes: true }); } catch { return []; }
    const found: SectionState[] = [];
    for (const d of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!d.isDirectory() || d.name === "records" || d.name.startsWith(".")) continue;
      const sdir = path.join(folder, d.name);
      const real = fs.realpathSync.native(sdir);
      if (!isInside(dir, real)) { diag("error", sdir, "section folder escapes project (symlink) — ignored"); continue; }
      const sfile = path.join(sdir, SECTION_FILE);
      if (!fs.existsSync(sfile)) continue; // plain folders are not sections
      const sraw = await readJson(sfile, 64 * 1024);
      if (!sraw.ok) { diag("error", sfile, `section.json: ${sraw.error}`); continue; }
      const sp = SectionManifest.safeParse(sraw.value);
      if (!sp.success) { diag("error", sfile, `section.json invalid: ${zodMessage(sp.error)}`); continue; }
      const m = sp.data;
      // Siblings are registered only after this loop, so check them here as well as the already-registered sections.
      if (p.sections.has(m.id) || found.some((f) => f.manifest.id === m.id)) { diag("error", sfile, `duplicate section id '${m.id}' — ignored`); continue; }
      if (!ALLOWED_CHILDREN[parentType].includes(m.displayType)) {
        diag("error", sfile, `${m.displayType} not allowed inside ${parentType} — ignored`);
        continue;
      }
      if (depth > MAX_SECTION_DEPTH) { diag("error", sfile, `nesting deeper than ${MAX_SECTION_DEPTH} — ignored`); continue; }
      const st: SectionState = { manifest: m, dir: real, relDir: path.relative(dir, real), parentId, depth, childIds: [], recordIds: [] };
      found.push(st);
    }
    // A container's children must share one display type; keep the majority type (ties: lowest order).
    let kept = found;
    if (found.length) {
      const byType = new Map<DisplayType, number>();
      for (const s of found) byType.set(s.manifest.displayType, (byType.get(s.manifest.displayType) ?? 0) + 1);
      const minOrder = (t: DisplayType) => Math.min(...found.filter((x) => x.manifest.displayType === t).map((x) => x.manifest.order));
      const keep = [...byType.entries()].sort((a, b) => b[1] - a[1] || minOrder(a[0]) - minOrder(b[0]))[0][0];
      for (const s of found) {
        if (s.manifest.displayType !== keep) {
          diag("error", path.join(s.dir, SECTION_FILE), `mixed child types under one parent: '${s.manifest.displayType}' ignored, siblings are '${keep}'`);
        }
      }
      kept = found.filter((s) => s.manifest.displayType === keep);
    }
    kept.sort((a, b) => a.manifest.order - b.manifest.order || a.manifest.title.localeCompare(b.manifest.title));
    const ids: string[] = [];
    for (const s of kept) {
      p.sections.set(s.manifest.id, s);
      if (s.manifest.visible) ids.push(s.manifest.id);
      if (s.manifest.displayType === "expandable-card") {
        await loadRecords(p, s, diag);
        const stray = (await fsp.readdir(s.dir, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== "records" && fs.existsSync(path.join(s.dir, d.name, SECTION_FILE)));
        for (const d of stray) diag("error", path.join(s.dir, d.name, SECTION_FILE), "expandable-card cannot contain sections — ignored");
      } else {
        s.childIds = await walk(s.dir, s.manifest.id, s.manifest.displayType, depth + 1);
        if (fs.existsSync(path.join(s.dir, "records"))) diag("warning", path.join(s.dir, "records"), `records/ is only read inside expandable-card sections — ignored`);
      }
    }
    return ids;
  };
  p.rootIds = await walk(sectionRoot, null, "root", 1);
  p.rootChildType = p.rootIds.length ? p.sections.get(p.rootIds[0])!.manifest.displayType : null;

  p.activity = await loadActivity(p);
  const ans = await loadAnswerIndex(dir, p.diagnostics);
  p.claims = ans.claims;
  p.answerStates = ans.states;
  p.uploads = await loadUploads(p);

  p.signature = await projectSignature(dir, manifest);
  p.indexMs = Math.round((performance.now() - t0) * 10) / 10;
  return p;
}

/** Load read state for the configured user (called by server after load when user != operator). */
export async function loadReadStateFor(p: ProjectState, user: string): Promise<void> {
  const rs = await readJson(readStateFile(p.dir, user));
  if (rs.ok) {
    const parsed = ReadState.safeParse(rs.value);
    if (parsed.success) p.readState = parsed.data;
  } else {
    p.readState = { schemaVersion: 1, user, seen: {} };
  }
}

type DiagFn = (level: Diagnostic["level"], file: string, message: string) => void;

function entryFromRecord(rec: AnyRecord, sectionId: string, file: string, sectionActions: Action[]): RecordEntry {
  const e: RecordEntry = {
    id: rec.id,
    recordType: rec.recordType,
    sectionId,
    file,
    title: rec.title,
    summary: rec.summary,
    status: rec.status,
    statusLabel: rec.statusLabel,
    priority: rec.priority,
    updatedAt: rec.updatedAt,
    order: rec.order,
    percent: rec.percent,
    notifyUser: rec.notifyUser,
    actions: (rec.actions ?? sectionActions).filter((a) => sectionActions.includes(a) || !rec.actions),
    attachments: rec.attachments,
  };
  if (rec.recordType === "question") {
    e.question = {
      requiresResponse: rec.requiresResponse,
      revision: rec.questionRevision,
      answerType: rec.answerSchema?.type,
      dueAt: rec.dueAt,
      taskId: rec.taskId,
    };
    if (rec.requiresResponse && !e.actions.includes("respond")) e.actions = [...e.actions, "respond"];
  }
  if (rec.attachments.length && !e.actions.includes("download")) e.actions = [...e.actions, "download"];
  if (rec.notifyUser && !e.actions.includes("mark-read")) e.actions = [...e.actions, "mark-read"];
  return e;
}

export async function parseRecordFile(file: string): Promise<{ ok: true; record: AnyRecord; mtimeMs: number } | { ok: false; error: string }> {
  const raw = await readJson(file, 1024 * 1024);
  if (!raw.ok) return { ok: false, error: raw.error };
  const parsed = AnyRecord.safeParse(raw.value);
  if (!parsed.success) return { ok: false, error: `invalid record: ${zodMessage(parsed.error)}` };
  return { ok: true, record: parsed.data, mtimeMs: raw.mtimeMs };
}

async function loadRecords(p: ProjectState, s: SectionState, diag: DiagFn): Promise<void> {
  const rdir = path.join(s.dir, "records");
  let files: string[];
  try { files = (await fsp.readdir(rdir)).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort(); } catch { return; }
  const parsed = await Promise.all(files.map(async (f) => ({ f: path.join(rdir, f), res: await parseRecordFile(path.join(rdir, f)) })));
  for (const { f, res } of parsed) {
    if (!res.ok) { diag("error", f, res.error); continue; }
    addRecord(p, s, f, res.record, diag);
  }
}

function addRecord(p: ProjectState, s: SectionState, file: string, rec: AnyRecord, diag: DiagFn): boolean {
  if (p.records.has(rec.id) && p.records.get(rec.id)!.file !== file) {
    diag("error", file, `duplicate record id '${rec.id}' (first in ${path.relative(p.dir, p.records.get(rec.id)!.file)}) — ignored`);
    return false;
  }
  for (const a of rec.attachments) {
    const owner = p.attachments.get(a.id);
    if (owner && owner.recordId !== rec.id) { diag("error", file, `duplicate attachment id '${a.id}' — ignored`); continue; }
    if (a.root !== "attachments" && !p.manifest.artifactRoots.includes(a.root)) {
      diag("warning", file, `attachment '${a.id}' uses undeclared root '${a.root}' — unavailable`);
    }
    p.attachments.set(a.id, { recordId: rec.id, att: a });
  }
  if (rec.recordType !== "question") {
    const wf = workflowFor(p.manifest, rec.recordType);
    if (!wf.statuses.some((x) => x.id === rec.status)) {
      const msg = `status '${rec.status}' is not in this project's ${rec.recordType} workflow`;
      if (wf.unknownStatus === "strict") { diag("error", file, `${msg} — ignored`); return false; }
      diag("warning", file, `${msg} — shown as open`);
    }
  }
  const entry = entryFromRecord(rec, s.manifest.id, file, s.manifest.actions);
  p.records.set(rec.id, entry);
  if (!s.recordIds.includes(rec.id)) s.recordIds.push(rec.id);
  return true;
}

function removeRecord(p: ProjectState, id: string): void {
  const r = p.records.get(id);
  if (!r) return;
  p.records.delete(id);
  const s = p.sections.get(r.sectionId);
  if (s) s.recordIds = s.recordIds.filter((x) => x !== id);
  for (const [aid, v] of p.attachments) if (v.recordId === id) p.attachments.delete(aid);
}

/** Refresh one record file. Returns the changed record id, null if nothing indexable, or "structural" when a full reload is needed. */
async function refreshRecordFile(p: ProjectState, file: string): Promise<string | null | "structural"> {
  const sectionDir = path.dirname(path.dirname(file));
  const s = [...p.sections.values()].find((x) => x.dir === sectionDir || x.dir === safeReal(sectionDir));
  if (!s || s.manifest.displayType !== "expandable-card") return "structural";
  const prev = [...p.records.values()].find((r) => r.file === file);
  if (!fs.existsSync(file)) {
    if (prev) { removeRecord(p, prev.id); return prev.id; }
    return null;
  }
  const res = await parseRecordFile(file);
  // Drop stale diagnostics for this file.
  const rel = path.relative(p.dir, file);
  p.diagnostics = p.diagnostics.filter((d) => d.path !== rel);
  if (prev) removeRecord(p, prev.id);
  if (!res.ok) {
    p.diagnostics.push({ level: "error", projectId: p.manifest.id, path: rel, message: res.error });
    return prev?.id ?? null;
  }
  const diag: DiagFn = (level, f, message) => p.diagnostics.push({ level, projectId: p.manifest.id, path: path.relative(p.dir, f), message });
  addRecord(p, s, file, res.record, diag);
  return res.record.id;
}

export async function loadProgressInto(p: ProjectState): Promise<void> {
  const file = safeResolve(p.dir, p.manifest.progressFile);
  const rel = path.relative(p.dir, file);
  p.diagnostics = p.diagnostics.filter((d) => d.path !== rel);
  const raw = await readJson(file, 256 * 1024);
  const empty: ProgressSummary = { overallPercent: null, label: "Overall progress", method: "", stale: false };
  if (!raw.ok) {
    if (raw.error !== "missing") p.diagnostics.push({ level: "error", projectId: p.manifest.id, path: rel, message: `progress: ${raw.error}` });
    p.progress = empty;
    p.progressBreakdown = [];
    return;
  }
  const parsed = ProgressFile.safeParse(raw.value);
  if (!parsed.success) {
    p.diagnostics.push({ level: "error", projectId: p.manifest.id, path: rel, message: `progress invalid: ${zodMessage(parsed.error)}` });
    p.progress = empty;
    p.progressBreakdown = [];
    return;
  }
  const d = parsed.data;
  const days = p.manifest.progressStaleAfterDays;
  const stale = !!(days && d.updatedAt && Date.now() - Date.parse(d.updatedAt) > days * 86_400_000);
  p.progress = { overallPercent: d.overallPercent ?? null, label: d.label, method: d.method, updatedAt: d.updatedAt, stale };
  p.progressBreakdown = d.breakdown;
}

export async function loadActivity(p: ProjectState): Promise<ActivityEvent[]> {
  const dir = safeResolve(p.dir, p.manifest.activityDir);
  let files: string[];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json") && !f.startsWith(".")); } catch { return []; }
  const relDir = path.relative(p.dir, dir);
  p.diagnostics = p.diagnostics.filter((d) => !(d.path ?? "").startsWith(relDir + path.sep));
  const out: ActivityEvent[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const raw = await readJson(path.join(dir, f), 64 * 1024);
    const parsed = raw.ok ? ActivityEvent.safeParse(raw.value) : null;
    if (!raw.ok || !parsed?.success) {
      p.diagnostics.push({ level: "warning", projectId: p.manifest.id, path: path.join(relDir, f), message: raw.ok ? `activity invalid: ${zodMessage(parsed?.error)}` : raw.error });
      continue;
    }
    if (seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    out.push(parsed.data);
  }
  out.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  return out;
}

export async function loadAnswerIndex(dir: string, diagnostics: Diagnostic[]): Promise<{ claims: Map<string, ClaimEntry>; states: Map<string, ProcessingState> }> {
  const claims = new Map<string, ClaimEntry>();
  const states = new Map<string, ProcessingState>();
  for (const st of PROCESSING_STATES) {
    let files: string[] = [];
    try { files = await fsp.readdir(path.join(dir, ANSWERS_DIR, st)); } catch { continue; }
    for (const f of files) if (f.endsWith(".json") && !f.startsWith(".")) states.set(f.slice(0, -5), st);
  }
  let cfiles: string[] = [];
  try { cfiles = await fsp.readdir(path.join(dir, CLAIMS_DIR)); } catch { /* none yet */ }
  for (const f of cfiles) {
    const m = /^(.+)@r(\d+)\.json$/.exec(f);
    if (!m) continue;
    const raw = await readJson(path.join(dir, CLAIMS_DIR, f), 16 * 1024);
    const v = raw.ok ? (raw.value as { answerId?: unknown; submittedAt?: unknown }) : null;
    if (!v || typeof v.answerId !== "string") {
      diagnostics.push({ level: "warning", path: path.join(CLAIMS_DIR, f), message: "claim file unreadable — ignored" });
      continue;
    }
    claims.set(claimKey(m[1], Number(m[2])), {
      answerId: v.answerId, questionId: m[1], revision: Number(m[2]),
      submittedAt: typeof v.submittedAt === "string" ? v.submittedAt : undefined,
    });
  }
  return { claims, states };
}

export async function loadUploads(p: ProjectState): Promise<Map<string, UploadMeta>> {
  const out = new Map<string, UploadMeta>();
  const dir = path.join(safeResolve(p.dir, p.manifest.allowedAttachmentRoot), UPLOAD_SUBDIR);
  let files: string[] = [];
  try { files = await fsp.readdir(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith(".meta.json")) continue;
    const raw = await readJson(path.join(dir, f), 16 * 1024);
    const parsed = raw.ok ? UploadMeta.safeParse(raw.value) : null;
    // The stored file must be named after the attachment id (no paths, no pointing at other files).
    if (parsed?.success && parsed.data.storedName.startsWith(`${parsed.data.attachmentId}.`) && f === `${parsed.data.attachmentId}.meta.json`) {
      out.set(parsed.data.attachmentId, parsed.data);
    } else {
      p.diagnostics.push({ level: "warning", projectId: p.manifest.id, path: path.join(p.manifest.allowedAttachmentRoot, UPLOAD_SUBDIR, f), message: "upload metadata invalid — ignored" });
    }
  }
  return out;
}

/** Stat-only fingerprint of everything that affects the index (except answers/user-state, handled separately). */
export async function projectSignature(dir: string, manifest: ProjectManifest): Promise<string> {
  const parts: string[] = [];
  const statFile = async (f: string) => {
    const st = await fsp.stat(f).catch(() => null);
    parts.push(`${f}:${st ? `${st.size}:${Math.round(st.mtimeMs)}` : "-"}`);
  };
  await statFile(path.join(dir, PROJECT_FILE));
  await statFile(path.join(dir, manifest.progressFile));
  const walk = async (d: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { parts.push(`d:${full}`); await walk(full, depth + 1); }
      else if (e.name.endsWith(".json")) await statFile(full);
    }
  };
  await walk(path.join(dir, manifest.rootSection), 0);
  await walk(path.join(dir, manifest.activityDir), 5);
  return `${parts.length}|${hashString(parts.join("\n"))}`;
}

function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
