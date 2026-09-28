import assert from "node:assert/strict";
import { test } from "node:test";

import { safePreview } from "../src/safe-preview.ts";

test("a preview is one printable, bounded line", () => {
  const preview = safePreview("echo \x1b[2Jhi\nrm -rf /\u202e" + "x".repeat(1000));
  assert.doesNotMatch(preview, /[\x00-\x1f\x7f\u202e]/);
  assert.match(preview, /^echo hi⏎ rm -rf \//);
  assert.match(preview, /more chars\)$/);
  assert.equal(safePreview(undefined), "null");
});
