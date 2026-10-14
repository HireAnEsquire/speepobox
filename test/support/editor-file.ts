// Where the editor bracket puts a session's file (T84, per-session since
// feature 01): under the runtime root, in a directory `FileSystem` minted for
// that session alone, both named for what the file is for. The unique part is
// not the test's to know, so the shape is what is asserted — and a fixed name
// under the root would fail it, which is the point.
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const editorFileUnder = (runtimeRoot: string, purpose: string): RegExp =>
  new RegExp(`^${escaped(runtimeRoot)}/${purpose}-edit-[^/]+/${purpose}-edit\\.txt$`);

// The editor as git invokes it (`sh -c` with the file as `"$1"`), over that
// same file.
export const editorInvocationUnder = (
  editor: string,
  runtimeRoot: string,
  purpose: string,
): RegExp =>
  new RegExp(
    `^sh -c ${escaped(`${editor} "$1" - `)}${editorFileUnder(runtimeRoot, purpose).source.slice(1)}`,
  );
