import { useCallback, useEffect, useState } from "react";
import { isDrawingPath } from "@context/drawings";
import type { FileBrowser } from "../../files/browser";
import type { RelatedAnswer } from "../../files/browser/relatedAnswer";

/**
 * What the related-notes panel can say about one note, and nothing it cannot.
 *
 * `hidden`: this browser has no `relatedNotes` (the demo console, a visitor),
 * or the note is a drawing or locked or encrypted, which are not asked about.
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

/**
 * An answer, and exactly what it answered: which asker (the workspace's bound
 * `relatedNotes`), which note, which attempt.
 */
type Settled = { ask: NonNullable<FileBrowser["relatedNotes"]>; path: string; attempt: number; outcome: RelatedAnswer | null };

export function useRelatedNotes(
  files: Pick<FileBrowser, "relatedNotes" | "sync" | "editor">,
  path: string,
): { state: RelatedState; retry: () => void } {
  const open = files.editor.path === path;
  const skipped = isDrawingPath(path) || (open && files.editor.encrypted);
  const ask = skipped ? undefined : files.relatedNotes;
  const offline = files.sync?.reachability === "offline";
  // The open note's version: a save moves it, and the related notes may have moved with it.
  const version = open ? files.editor.etag : null;
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (ask === undefined || offline) return;
    let live = true;
    ask(path).then(
      (answer) => live && setSettled({ ask, path, attempt, outcome: answer }),
      () => live && setSettled({ ask, path, attempt, outcome: null }),
    );
    // A later note, workspace, retry, save or reconnect makes this answer stale: it is dropped.
    return () => {
      live = false;
    };
  }, [ask, offline, path, attempt, version]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (ask === undefined) return { state: { kind: "hidden" }, retry };
  if (offline) return { state: { kind: "offline" }, retry };
  /*
    Only an answer from this asker, about this note, to this attempt counts.
    A save (`version`) is deliberately not part of the key: the previous
    answer about the same note stays on screen while the new one is fetched.
  */
  if (settled === null || settled.ask !== ask || settled.path !== path || settled.attempt !== attempt) {
    return { state: { kind: "loading" }, retry };
  }
  if (settled.outcome === null) return { state: { kind: "unavailable" }, retry };
  return { state: { kind: "ready", answer: settled.outcome }, retry };
}
