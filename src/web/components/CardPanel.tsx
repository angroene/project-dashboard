import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { NavNode, RecordDetail, RecordPage, RecordSummary } from "../../shared/api";
import { apiGet, apiPostDownload, enc, errorMessage, projectApi, qk, type RecordListParams } from "../api/client";
import { useDebounced, useProject } from "../context";
import { recordPlainText } from "../format";
import { ErrorNote, Loading, NodeBadges, Pill } from "./common";
import { Icon } from "./Icon";
import { RecordRow } from "./RecordRow";
import { useCopy, useToast } from "./Toasts";
import { ZipDialog } from "./ZipDialog";
import { ImportDialog } from "./ImportDialog";

const SORTS: { value: string; label: string }[] = [
  { value: "updated-desc", label: "Recently updated" },
  { value: "updated-asc", label: "Least recently updated" },
  { value: "priority", label: "Priority" },
  { value: "title", label: "Title" },
  { value: "order", label: "Manual order" },
];

/** An expandable-card section (or, with collapsible=false, the records view of a tab). */
export function CardPanel({ node, collapsible = true }: { node: NavNode; collapsible?: boolean }) {
  const { focus } = useProject();
  const focusId = focus?.sectionId === node.id ? focus.recordId : undefined;
  const [open, setOpen] = useState(!collapsible || node.defaultOpen || !!focusId);
  const [mounted, setMounted] = useState(open);
  // A newly focused record (linked from elsewhere) opens its card: adjust state during render, not in an effect.
  const [seenFocus, setSeenFocus] = useState(focusId);
  if (focusId !== seenFocus) {
    setSeenFocus(focusId);
    if (focusId) {
      setOpen(true);
      setMounted(true);
    }
  }
  const bodyId = useId();
  const headingId = useId();
  const toggle = () => {
    setOpen((o) => !o);
    setMounted(true);
  };

  return (
    <section className="panel card-panel" data-section-id={node.id} aria-labelledby={headingId}>
      <div className="card-head">
        <h2 className="card-title" id={headingId}>
          {collapsible ? (
            <button type="button" className="card-toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
              <Icon name={node.icon} />
              <span className="card-title-text">{node.title}</span>
              <span className="badges">
                <Pill>
                  {node.counts.records} {node.counts.records === 1 ? "item" : "items"}
                </Pill>
                <NodeBadges counts={node.counts} />
              </span>
              <span className={`chevron${open ? " open" : ""}`} aria-hidden="true">
                ▾
              </span>
            </button>
          ) : (
            <span className="card-toggle static">
              <Icon name={node.icon} />
              <span className="card-title-text">{node.title}</span>
              <span className="badges">
                <NodeBadges counts={node.counts} />
              </span>
            </span>
          )}
        </h2>
        {node.description && <p className="small muted card-desc">{node.description}</p>}
      </div>
      <div id={bodyId} hidden={!open}>
        {mounted && <RecordList node={node} focusId={focusId} />}
      </div>
    </section>
  );
}

/** Question UI state the server accepts as a status filter: answerable questions without an answer yet. */
const NEEDS_RESPONSE = "needs-response";

function RecordList({ node, focusId }: { node: NavNode; focusId?: string }) {
  const { pid } = useProject();
  const copy = useCopy();
  const toast = useToast();
  const searchId = useId();
  const [status, setStatus] = useState(node.filters.defaultStatus ?? "");
  const [qInput, setQInput] = useState("");
  const q = useDebounced(qInput.trim(), 300);
  const [sort, setSort] = useState(node.filters.sort);
  const params: RecordListParams = useMemo(() => ({ status, q, sort, limit: node.pageSize }), [status, q, sort, node.pageSize]);

  const query = useInfiniteQuery({
    queryKey: qk.records(pid, node.id, params),
    queryFn: ({ pageParam, signal }) => {
      const sp = new URLSearchParams({ limit: String(params.limit), sort: params.sort });
      // Without a status the server applies the section's defaultStatus; "all" disables status filtering.
      sp.set("status", params.status || "all");
      if (params.q) sp.set("q", params.q);
      if (pageParam) sp.set("cursor", pageParam);
      return apiGet<RecordPage>(`${projectApi(pid)}/sections/${enc(node.id)}/records?${sp}`, signal);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: RecordSummary[] = [];
    for (const p of query.data?.pages ?? []) {
      for (const r of p.items) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          out.push(r);
        }
      }
    }
    return out;
  }, [query.data]);
  const first = query.data?.pages[0];

  // Selection (records kept by id so bulk actions can use their summaries).
  const [selected, setSelected] = useState<Map<string, RecordSummary>>(() => new Map());
  // Changing the filter, search or sort clears the selection.
  const filterKey = `${status}\u0000${q}\u0000${sort}`;
  const [selectionKey, setSelectionKey] = useState(filterKey);
  if (selectionKey !== filterKey) {
    setSelectionKey(filterKey);
    setSelected(new Map());
  }
  const onSelect = useCallback((r: RecordSummary, on: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (on) next.set(r.id, r);
      else next.delete(r.id);
      return next;
    });
  }, []);

  const actions = node.actions;
  const selectable = actions.includes("copy") || actions.includes("export-xlsx") || actions.includes("bulk-download");
  const allSelected = items.length > 0 && items.every((r) => selected.has(r.id));
  const someSelected = items.some((r) => selected.has(r.id));
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);
  const toggleAll = (on: boolean) =>
    setSelected((prev) => {
      const next = new Map(prev);
      for (const r of items) {
        if (on) next.set(r.id, r);
        else next.delete(r.id);
      }
      return next;
    });

  // Prefer the freshest loaded summary for each selected record (lists refetch after SSE invalidation).
  const itemsById = useMemo(() => new Map(items.map((r) => [r.id, r])), [items]);
  const sel = [...selected.values()].map((r) => itemsById.get(r.id) ?? r);
  const questionIds = sel.filter((r) => r.recordType === "question").map((r) => r.id);
  const withFiles = sel.filter((r) => r.attachmentCount > 0).map((r) => r.id);
  const canCopy = actions.includes("copy") && sel.length > 0;
  const canExport = actions.includes("export-xlsx") && questionIds.length > 0;
  const canZip = actions.includes("bulk-download") && withFiles.length > 0;
  const canImport = actions.includes("import-xlsx");

  const [zipIds, setZipIds] = useState<string[] | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const exportXlsx = async () => {
    setExporting(true);
    try {
      const name = await apiPostDownload(`${projectApi(pid)}/export/xlsx`, { questionIds }, `${pid}-questions.xlsx`);
      toast(`Exported ${questionIds.length} ${questionIds.length === 1 ? "question" : "questions"} to ${name}`);
    } catch (e) {
      toast(`Excel export failed: ${errorMessage(e)}`, "error");
    } finally {
      setExporting(false);
    }
  };

  // Status vocabularies are project-defined; the server sends a label for every counted status.
  const statusLabels = first?.statusLabels ?? {};
  const statusChips = useMemo(() => {
    const counts = first?.statusCounts ?? {};
    const keys = node.filters.statuses ?? Object.keys(counts);
    return keys.map((k) => ({ value: k, count: counts[k] ?? 0 }));
  }, [first, node.filters.statuses]);

  const focusInList = !!focusId && items.some((r) => r.id === focusId);

  return (
    <div className="record-list-wrap">
      <div className="filters">
        {(statusChips.length > 0 || first?.needsResponseCount !== undefined) && (
          <div className="chips" role="group" aria-label="Filter by status">
            <button type="button" className={`chip${status === "" ? " active" : ""}`} aria-pressed={status === ""} onClick={() => setStatus("")}>
              All <span className="chip-count">{first?.unfilteredTotal ?? 0}</span>
            </button>
            {first?.needsResponseCount !== undefined && (
              <button
                type="button"
                className={`chip${status === NEEDS_RESPONSE ? " active" : ""}`}
                aria-pressed={status === NEEDS_RESPONSE}
                onClick={() => setStatus(NEEDS_RESPONSE)}
              >
                Needs response <span className="chip-count">{first.needsResponseCount}</span>
              </button>
            )}
            {statusChips.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`chip${status === c.value ? " active" : ""}`}
                aria-pressed={status === c.value}
                onClick={() => setStatus(c.value)}
              >
                {statusLabels[c.value] ?? c.value} <span className="chip-count">{c.count}</span>
              </button>
            ))}
          </div>
        )}
        <div className="filter-row">
          <label className="sr-only" htmlFor={`${searchId}-q`}>
            Search {node.title}
          </label>
          <input id={`${searchId}-q`} className="input input-search" type="search" placeholder="Search…" value={qInput} onChange={(e) => setQInput(e.target.value)} />
          <label className="sr-only" htmlFor={`${searchId}-sort`}>
            Sort
          </label>
          <select id={`${searchId}-sort`} className="input select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {(selectable || canImport) && (
        <div className="toolbar" role="toolbar" aria-label={`${node.title} actions`}>
          {selectable && (
            <label className="check select-all">
              <input ref={selectAllRef} type="checkbox" checked={allSelected} disabled={items.length === 0} onChange={(e) => toggleAll(e.target.checked)} />
              <span>Select all on page</span>
            </label>
          )}
          {selectable && (
            <span className="small muted" aria-live="polite">
              {sel.length > 0 ? `${sel.length} selected` : "Select records for bulk actions"}
            </span>
          )}
          <div className="tools">
            {canCopy && (
              <button type="button" className="btn btn-sm" onClick={() => void copy(sel.map(recordPlainText).join("\n\n"), `${sel.length} ${sel.length === 1 ? "record" : "records"}`)}>
                ⧉ Copy selected
              </button>
            )}
            {canExport && (
              <button type="button" className="btn btn-sm" disabled={exporting} onClick={() => void exportXlsx()}>
                ↓ {exporting ? "Exporting…" : `Export to Excel (${questionIds.length})`}
              </button>
            )}
            {canZip && (
              <button type="button" className="btn btn-sm" onClick={() => setZipIds(withFiles)}>
                ↓ Download ZIP ({withFiles.length})
              </button>
            )}
            {canImport && (
              <button type="button" className="btn btn-sm" onClick={() => setImportOpen(true)}>
                ↑ Import Excel
              </button>
            )}
          </div>
        </div>
      )}

      {query.isPending && <Loading label="Loading records…" />}
      {query.isError && <ErrorNote error={query.error} onRetry={() => void query.refetch()} />}

      {focusId && !focusInList && query.data && <FocusedRecord recordId={focusId} />}

      {query.data && items.length === 0 && <p className="muted empty-list">{first && first.unfilteredTotal > 0 ? "No records match the current filter." : "No records yet."}</p>}

      {items.length > 0 && (
        <ul className={`records${query.isPlaceholderData ? " stale" : ""}`} role="list" aria-busy={query.isFetching}>
          {items.map((r) => (
            <RecordRow key={r.id} summary={r} selectable={selectable} selected={selected.has(r.id)} onSelect={onSelect} focused={r.id === focusId} />
          ))}
        </ul>
      )}

      {query.data && (
        <p className="small muted list-footer">
          Showing {items.length} of {first?.total ?? items.length}
        </p>
      )}
      {query.hasNextPage && (
        <button type="button" className="btn load-more" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}

      {zipIds && <ZipDialog recordIds={zipIds} onClose={() => setZipIds(null)} />}
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}
    </div>
  );
}

/** A linked record that is not on the loaded page of its list: show it on its own, expanded. */
function FocusedRecord({ recordId }: { recordId: string }) {
  const { pid } = useProject();
  const q = useQuery({
    queryKey: qk.record(pid, recordId),
    queryFn: ({ signal }) => apiGet<RecordDetail>(`${projectApi(pid)}/records/${enc(recordId)}`, signal),
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorNote prefix={`Could not load ${recordId}`} error={q.error} />;
  return (
    <div className="focused-record">
      <p className="small muted">Linked record</p>
      <ul className="records" role="list">
        <RecordRow summary={q.data} selectable={false} selected={false} onSelect={noop} focused />
      </ul>
    </div>
  );
}

function noop() {}

/** A record whose section is not in the navigation (hidden or removed section). */
export function StandaloneRecord({ record }: { record: RecordDetail }) {
  return (
    <section className="panel" aria-label="Linked record">
      <p className="small muted">This record is not part of a visible section.</p>
      <ul className="records" role="list">
        <RecordRow summary={record} selectable={false} selected={false} onSelect={noop} focused />
      </ul>
    </section>
  );
}
