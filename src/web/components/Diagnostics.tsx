import { useQuery } from "@tanstack/react-query";
import type { DiagnosticsResponse } from "../../shared/api";
import { apiGet, qk } from "../api/client";
import { formatAbsolute } from "../format";
import { homeHref } from "../routes";
import { ErrorNote, Loading, Pill } from "./common";

export function Diagnostics() {
  const q = useQuery({ queryKey: qk.diagnostics, queryFn: ({ signal }) => apiGet<DiagnosticsResponse>("/api/diagnostics", signal) });
  const d = q.data;
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li>
            <a href={homeHref}>All projects</a>
          </li>
          <li aria-current="page">Diagnostics</li>
        </ol>
      </nav>
      <div className="hero">
        <div>
          <div className="eyebrow">Developer status</div>
          <h1 tabIndex={-1}>Diagnostics</h1>
          {d && <p>Index built {formatAbsolute(d.indexedAt)}.</p>}
        </div>
      </div>
      {q.isPending && <Loading />}
      {q.isError && <ErrorNote error={q.error} onRetry={() => void q.refetch()} />}
      {d && (
        <>
          <section className="panel">
            <h2 className="section-title">Problems ({d.diagnostics.length})</h2>
            {d.diagnostics.length === 0 ? (
              <p>No configuration problems found.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Level</th>
                      <th scope="col">Project</th>
                      <th scope="col">Path</th>
                      <th scope="col">Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.diagnostics.map((x, i) => (
                      <tr key={i}>
                        <td>
                          <Pill tone={x.level === "error" ? "danger" : "warn"}>{x.level === "error" ? "Error" : "Warning"}</Pill>
                        </td>
                        <td>{x.projectId ?? "—"}</td>
                        <td className="mono break">{x.path ?? "—"}</td>
                        <td className="break">{x.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="panel">
            <h2 className="section-title">Project index</h2>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col">Sections</th>
                    <th scope="col">Records</th>
                    <th scope="col">Index time</th>
                  </tr>
                </thead>
                <tbody>
                  {d.projects.map((p) => (
                    <tr key={p.id}>
                      <td>{p.id}</td>
                      <td>{p.sections}</td>
                      <td>{p.records}</td>
                      <td>{p.indexMs} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
