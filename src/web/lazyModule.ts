import { useEffect, useState } from "react";

/**
 * Code-split module loaded on demand WITHOUT Suspense: React 19 throttles revealing suspended
 * content (~300 ms), which made the first record expand feel slow even with a warm chunk.
 */
export function lazyModule<T>(loader: () => Promise<T>) {
  let mod: T | undefined;
  let pending: Promise<T> | undefined;
  const load = (): Promise<T> => {
    pending ??= loader().then((m) => (mod = m));
    return pending;
  };
  function useModule(): T | undefined {
    const [m, setM] = useState<T | undefined>(mod);
    useEffect(() => {
      if (m) return;
      let alive = true;
      load().then(
        (x) => alive && setM(x),
        (e: unknown) => console.error("Failed to load module", e),
      );
      return () => {
        alive = false;
      };
    }, [m]);
    return m;
  }
  return { load, useModule };
}
