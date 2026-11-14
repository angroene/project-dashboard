import { useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiPost, errorMessage, qk } from "../api/client";

export function Login({ productName }: { productName: string }) {
  const qc = useQueryClient();
  const id = useId();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/auth/login", { token });
      setToken("");
      await qc.invalidateQueries({ queryKey: qk.session });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel login" onSubmit={(e) => void submit(e)} aria-describedby={error ? `${id}-err` : undefined}>
      <h1 tabIndex={-1}>Sign in</h1>
      <p>{productName} requires an access token on this connection.</p>
      <label className="field-label" htmlFor={`${id}-token`}>
        Access token
      </label>
      <input
        id={`${id}-token`}
        className="input"
        type="password"
        autoComplete="current-password"
        required
        value={token}
        onChange={(e) => setToken(e.target.value)}
        aria-invalid={!!error}
      />
      {error && (
        <p id={`${id}-err`} className="field-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn primary" disabled={busy || !token}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
