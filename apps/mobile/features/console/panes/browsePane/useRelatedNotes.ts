import { useCallback, useEffect, useState } from "react";
import type { FileBrowser } from "../../files/browser";
import type { RelatedAnswer } from "../../files/browser/relatedAnswer";

/**
 * What the related-notes panel can say about one note, and nothing it cannot.
 *
 * `hidden`: this browser has no `relatedNotes` (the demo console, a visitor).
 * `offline`: nothing is asked. No local graph is computed (arch 15.2 makes it
 * optional), so the panel says it needs a connection rather than guessing.
 * `loading` and `unavailable` are never an empty list (arch 14).
 */
export type RelatedState =
  | { kind: "hidden" }
  | { kind: "offline" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; answer: RelatedAnswer };

type Settled = { path: string; attempt: number; outcome: RelatedAnswer | null };

export function useRelatedNotes(
  files: Pick<FileBrowser, "relatedNotes" | "sync">,
  path: string,
): { state: RelatedState; retry: () => void } {
  const ask = files.relatedNotes;
  const offline = files.sync?.reachability === "offline";
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (ask === undefined || offline) return;
    let live = true;
    ask(path).then(
      (answer) => live && setSettled({ path, attempt, outcome: answer }),
      () => live && setSettled({ path, attempt, outcome: null }),
    );
    // A later note, retry or reconnect makes this answer stale: it is dropped.
    return () => {
      live = false;
    };
  }, [ask, offline, path, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (ask === undefined) return { state: { kind: "hidden" }, retry };
  if (offline) return { state: { kind: "offline" }, retry };
  // Only an answer to this note and this attempt counts; anything older is still loading.
  if (settled === null || settled.path !== path || settled.attempt !== attempt) return { state: { kind: "loading" }, retry };
  if (settled.outcome === null) return { state: { kind: "unavailable" }, retry };
  return { state: { kind: "ready", answer: settled.outcome }, retry };
}
