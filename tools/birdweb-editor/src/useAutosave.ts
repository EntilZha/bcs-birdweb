import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "clean" | "dirty" | "saving" | "saved" | "error";

/**
 * Debounced, clobber-safe autosave.
 *
 * The subtle part is the coalescing: if edits land while a save is in flight, we must not
 * adopt the server's echo of the older state, and we must not fire a second overlapping
 * write. Instead the newer client state is kept and one more save is scheduled for when
 * the current one lands. Without this, typing fast enough to overlap two saves silently
 * reverts characters.
 */
export function useAutosave<T>(
  value: T,
  save: (value: T) => Promise<{ issues?: Array<{ path: string; message: string }> }>,
  { delay = 800, enabled = true }: { delay?: number; enabled?: boolean } = {},
) {
  const [state, setState] = useState<SaveState>("clean");
  const [issues, setIssues] = useState<Array<{ path: string; message: string }>>([]);
  const savingRef = useRef(false);
  const rerunRef = useRef(false);
  const latestRef = useRef(value);
  const baselineRef = useRef<string | null>(null);

  latestRef.current = value;

  // The first value seen for a record is its baseline; edits are measured against it so
  // that merely opening a record never marks it dirty.
  useEffect(() => {
    baselineRef.current = JSON.stringify(value);
    setState("clean");
    setIssues([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled && (value as { slug?: string })?.slug]);

  const persist = useCallback(async () => {
    if (savingRef.current) {
      rerunRef.current = true;
      return;
    }
    savingRef.current = true;
    setState("saving");
    try {
      const result = await save(latestRef.current);
      if (result.issues?.length) {
        setIssues(result.issues);
        setState("error");
      } else {
        setIssues([]);
        baselineRef.current = JSON.stringify(latestRef.current);
        setState("saved");
      }
    } catch {
      setState("error");
    } finally {
      savingRef.current = false;
      if (rerunRef.current) {
        rerunRef.current = false;
        void persist();
      }
    }
  }, [save]);

  useEffect(() => {
    if (!enabled || baselineRef.current === null) return;
    if (JSON.stringify(value) === baselineRef.current) return;
    setState("dirty");
    const timer = setTimeout(() => void persist(), delay);
    return () => clearTimeout(timer);
  }, [value, delay, enabled, persist]);

  // Nobody should lose an edit to a closed tab.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (state === "dirty" || state === "saving") event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [state]);

  return { state, issues, saveNow: persist };
}
