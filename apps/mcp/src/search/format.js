/**
 * The search index format: one tokenizer (`text.js`), chunked notes and an
 * anchor-text field, all always on. There is no switch and no second format.
 *
 * `INDEX_FORMAT_VERSION` is the manifest's `version`. A stored manifest with
 * any other version is read as absent and the index is rebuilt from the notes
 * (everything under `.context/search/` is a disposable derivative). Bump it
 * whenever the tokenizer, the chunk shape or the stored layout changes, so an
 * index built by older code is never served. Version 5 was the first with the
 * tokenizer, chunking and anchor text as the only behavior. Version 6 adds the
 * irregular-forms layer in front of Porter2 (`irregular.js`).
 *
 * Chunking: an ordinary note is indexed as chunks of about `CHUNK.target`
 * characters (at most `CHUNK.max`), up to `CHUNK.cap` characters per note. The
 * target is 1,000, the smallest size that met the decision rule (ruling
 * OPEN-66; docs/design/link-graph/RESULTS.md). `max = 1.5 * target` (ruling
 * OPEN-54).
 */

export const INDEX_FORMAT_VERSION = 6;

export const CHUNK = Object.freeze({ target: 1000, max: 1500, cap: 64_000 });
