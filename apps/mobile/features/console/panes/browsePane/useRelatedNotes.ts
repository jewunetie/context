import { useCallback, useEffect, useState } from "react";
import { isDrawingPath } from "@context/drawings";
import type { FileBrowser } from "../../files/browser";
import type { RelatedAnswer } from "../../files/browser/relatedAnswer";

/**
 * What the related-notes panel can say about one note, and nothing it cannot.
 *
 * `hidden`: this browser has no `relatedNotes` (the demo console, a visitor),
 * or the note is a drawing, locked or encrypted, or not saved yet (no etag),
 * which are not asked about.
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

/** How long the open note's version must hold still after a save before the panel asks again. */
export const REFRESH_AFTER_SAVE_MS = 2000;

export function useRelatedNotes(
  files: Pick<FileBrowser, "relatedNotes" | "sync" | "editor">,
  path: string,
): { state: RelatedState; retry: () => void } {
  const open = files.editor.path === path;
  // A note with no version yet has never been saved: nothing to relate, and no "Finding…" line forever.
  const skipped = isDrawingPath(path) || (open && (files.editor.encrypted || files.editor.etag === null));
  const ask = skipped ? undefined : files.relatedNotes;
  const offline = files.sync?.reachability === "offline";
  /*
    The version the editor holds of this note, or null until it holds one. No
    request goes out before that: until the read lands the panel cannot know
    whether the note is locked, and asking at the path alone and again at the
    version cost two requests for one open.
  */
  const version = open ? files.editor.etag : null;
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled | null>(null);
  // The version the last request was (or is about to be) made at, for this path.
  const [asked, setAsked] = useState<{ path: string; version: string } | null>(null);

  useEffect(() => {
    if (version === null) return;
    // First sight of this note: ask now.
    if (asked === null || asked.path !== path) {
      setAsked({ path, version });
      return;
    }
    if (asked.version === version) return;
    // A save moved the version: ask again once it has held still, so a burst of autosaves costs one request.
    const timer = setTimeout(() => setAsked({ path, version }), REFRESH_AFTER_SAVE_MS);
    return () => clearTimeout(timer);
  }, [asked, path, version]);

  const askedVersion = asked !== null && asked.path === path ? asked.version : null;

  useEffect(() => {
    if (ask === undefined || offline || askedVersion === null) return;
    let live = true;
    ask(path).then(
      (answer) => live && setSettled({ ask, path, attempt, outcome: answer }),
      () => live && setSettled({ ask, path, attempt, outcome: null }),
    );
    // A later note, workspace, retry, settled save or reconnect makes this answer stale: it is dropped.
    return () => {
      live = false;
    };
  }, [ask, offline, path, attempt, askedVersion]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (ask === undefined) return { state: { kind: "hidden" }, retry };
  if (offline) return { state: { kind: "offline" }, retry };
  /*
    Only an answer from this asker, about this note, to this attempt counts.
    A save is deliberately not part of the key: the previous answer about the
    same note stays on screen while the new one is fetched.
  */
  if (settled === null || settled.ask !== ask || settled.path !== path || settled.attempt !== attempt) {
    return { state: { kind: "loading" }, retry };
  }
  if (settled.outcome === null) return { state: { kind: "unavailable" }, retry };
  return { state: { kind: "ready", answer: settled.outcome }, retry };
}
