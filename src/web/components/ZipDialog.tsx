import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ZipPreflight } from "../../shared/api";
import { apiPost, apiPostDownload, errorMessage, projectApi } from "../api/client";
import { useProject } from "../context";
import { formatBytes } from "../format";
import { ErrorNote, Loading, Modal } from "./common";
import { useToast } from "./Toasts";

/** Preflight first (shows what is missing), then downloads the ZIP of the available attachments. */
export function ZipDialog({ recordIds, onClose }: { recordIds: string[]; onClose: () => void }) {
  const { pid } = useProject();
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const pre = useQuery({
    queryKey: ["zip-preflight", pid, recordIds],
    queryFn: () => apiPost<ZipPreflight>(`${projectApi(pid)}/download/zip/preflight`, { recordIds }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const download = async () => {
    setDownloading(true);
    try {
      const name = await apiPostDownload(`${projectApi(pid)}/download/zip`, { recordIds }, `${pid}-documents.zip`);
      toast(`Downloaded ${name}`);
      onClose();
    } catch (e) {
      toast(`ZIP download failed: ${errorMessage(e)}`, "error");
    } finally {
      setDownloading(false);
    }
  };

  const d = pre.data;
  return (
    <Modal title="Download selected documents" onClose={onClose}>
      {pre.isPending && <Loading label="Checking attachments…" />}
      {pre.isError && <ErrorNote error={pre.error} onRetry={() => void pre.refetch()} />}
      {d && (
        <>
          <p>
            {d.available.length} {d.available.length === 1 ? "file" : "files"} available ({formatBytes(d.totalBytes)}).
          </p>
          {d.available.length > 0 && (
            <ul className="file-list" role="list">
              {d.available.map((a) => (
                <li key={a.id}>
                  {a.fileName} <span className="small muted">· {formatBytes(a.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
          {d.missing.length > 0 && (
            <div className="notice notice-warn">
              <strong>
                {d.missing.length} {d.missing.length === 1 ? "attachment is" : "attachments are"} unavailable and will not be included:
              </strong>
              <ul role="list">
                {d.missing.map((m) => (
                  <li key={m.attachmentId}>
                    <span className="mono">{m.attachmentId}</span>
                    {m.recordId && <span> ({m.recordId})</span>}: {m.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="tools modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={d.available.length === 0 || downloading} onClick={() => void download()}>
              {downloading ? "Preparing…" : "Download ZIP"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
