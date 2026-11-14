import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiRequestError, qk, setUnauthorizedHandler } from "./api/client";
import { ToastProvider } from "./components/Toasts";
import { App } from "./App";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      // Live updates arrive via SSE invalidation; focus refetches would only duplicate them.
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiRequestError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

setUnauthorizedHandler(() => {
  void queryClient.invalidateQueries({ queryKey: qk.session });
});

const el = document.getElementById("root");
if (!el) throw new Error("Missing #root element");
createRoot(el).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
