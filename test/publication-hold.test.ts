import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

test("publication hold fails closed without publishing credentials", () => {
  const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "publication-hold.mjs")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 78);
  assert.match(result.stderr, /COMMERCIALIZATION_PUBLICATION_HOLD/);
});
