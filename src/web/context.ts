import { createContext, useContext, useEffect, useState } from "react";
import type { AttentionGroup, NavNode, SessionInfo } from "../shared/api";

export const SessionContext = createContext<SessionInfo | null>(null);

export function useSession(): SessionInfo {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession must be used inside SessionContext");
  return s;
}

export interface NavEntry {
  node: NavNode;
  /** Route path (main-tab / page-tab ids) that shows this section. */
  tabPath: string[];
}
export type NavIndex = Map<string, NavEntry>;

export function buildNavIndex(nodes: NavNode[]): NavIndex {
  const map: NavIndex = new Map();
  const walk = (list: NavNode[], path: string[]) => {
    for (const n of list) {
      const own = n.displayType === "expandable-card" ? path : [...path, n.id];
      map.set(n.id, { node: n, tabPath: own });
      walk(n.children, own);
    }
  };
  walk(nodes, []);
  return map;
}

export interface ProjectCtx {
  pid: string;
  navIndex: NavIndex;
  /** Record requested via ?record=, with the section it lives in once known. */
  focus: { recordId: string; sectionId: string } | null;
  /** Attention group requested via ?attention= (opened and scrolled into view). */
  attention?: AttentionGroup;
}

export const ProjectContext = createContext<ProjectCtx | null>(null);

export function useProject(): ProjectCtx {
  const c = useContext(ProjectContext);
  if (!c) throw new Error("useProject must be used inside ProjectContext");
  return c;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
