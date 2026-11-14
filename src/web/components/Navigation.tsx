import { useRef, type KeyboardEvent, type ReactNode } from "react";
import type { NavNode } from "../../shared/api";
import { useProject } from "../context";
import { navigate, projectHref } from "../routes";
import { Icon } from "./Icon";
import { NodeBadges } from "./common";
import { CardPanel } from "./CardPanel";
import { ProgressPanel } from "./ProgressPanel";
import { ActivityPanel } from "./ActivityPanel";
import { AttentionPanel } from "./AttentionPanel";

const domId = (prefix: string, id: string) => `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

export function WorkAreas({ nodes, selectedId }: { nodes: NavNode[]; selectedId?: string }) {
  const { pid } = useProject();
  return (
    <nav aria-label="Work areas">
      <ul className="workareas" role="list">
        {nodes.map((n) => {
          const active = n.id === selectedId;
          return (
            <li key={n.id}>
              <a className={`workarea${active ? " active" : ""}`} href={projectHref(pid, [n.id])} aria-current={active ? "page" : undefined}>
                <strong className="workarea-title">
                  <Icon name={n.icon} /> {n.title}
                </strong>
                {n.description && (
                  <span className="muted workarea-desc">
                    <span className="sr-only">: </span>
                    {n.description}
                  </span>
                )}
                <span className="badges">
                  <NodeBadges counts={n.counts} />
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Horizontal tabs (WAI-ARIA tabs pattern, automatic activation). Scrolls horizontally inside itself on narrow screens. */
export function TabBar({ tabs, selectedId, hrefFor, label }: { tabs: NavNode[]; selectedId?: string; hrefFor: (t: NavNode) => string; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIdx = tabs.findIndex((t) => t.id === selectedId);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let n = -1;
    if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = tabs.length - 1;
    if (n < 0) return;
    e.preventDefault();
    refs.current[n]?.focus();
    navigate(hrefFor(tabs[n]));
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => {
        const active = i === selectedIdx;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={domId("tab", t.id)}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={active ? domId("tabpanel", t.id) : undefined}
            tabIndex={active || (selectedIdx < 0 && i === 0) ? 0 : -1}
            className={`tab${active ? " active" : ""}`}
            title={t.description || undefined}
            onClick={() => navigate(hrefFor(t))}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.icon && <Icon name={t.icon} size={16} />}
            <span>{t.title}</span>
            <NodeBadges counts={t.counts} />
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ tabId, children }: { tabId: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={domId("tabpanel", tabId)} aria-labelledby={domId("tab", tabId)} className="tabpanel">
      {children}
    </div>
  );
}

/** Built-in panels requested by a section manifest, rendered before its children. */
function Views({ node }: { node: NavNode }) {
  if (node.views.length === 0) return null;
  return (
    <>
      {node.views.map((v) => {
        switch (v) {
          case "progress":
            return <ProgressPanel key={v} />;
          case "activity":
            return <ActivityPanel key={v} />;
          case "attention":
            return <AttentionPanel key={v} />;
          case "records":
            return <CardPanel key={v} node={node} collapsible={false} />;
          default:
            return null;
        }
      })}
    </>
  );
}

/** Content of a main-tab or page-tab: description, views, then its page tabs and/or cards. */
export function SectionContent({ node, selectedPageId }: { node: NavNode; selectedPageId?: string }) {
  const { pid, navIndex } = useProject();
  const pages = node.children.filter((c) => c.displayType === "page-tab");
  const cards = node.children.filter((c) => c.displayType === "expandable-card");
  const page = pages.find((p) => p.id === selectedPageId);
  const basePath = navIndex.get(node.id)?.tabPath ?? [node.id];
  return (
    <div className="section-content">
      {node.description && node.displayType === "page-tab" && <p className="section-desc">{node.description}</p>}
      <Views node={node} />
      {pages.length > 0 && (
        <>
          <TabBar tabs={pages} selectedId={page?.id} hrefFor={(t) => projectHref(pid, [...basePath, t.id])} label={node.title} />
          {page && (
            <TabPanel tabId={page.id}>
              <SectionContent node={page} />
            </TabPanel>
          )}
        </>
      )}
      {cards.length > 0 && (
        <div className="card-list">
          {cards.map((c) => (
            <CardPanel key={c.id} node={c} />
          ))}
        </div>
      )}
      {pages.length === 0 && cards.length === 0 && node.views.length === 0 && <p className="muted">This section has no content yet.</p>}
    </div>
  );
}
