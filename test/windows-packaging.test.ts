import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyAsInvokerExecutable, verifyAsInvokerManifestText } from "../scripts/lib/windows-pe-manifest.mjs";
import { inspectWindowsStandardUserToken } from "../scripts/lib/windows-standard-user.mjs";

function manifest(level: string, uiAccess = "false"): string {
  return `<assembly><trustInfo><security><requestedPrivileges><requestedExecutionLevel level="${level}" uiAccess="${uiAccess}" /></requestedPrivileges></security></trustInfo></assembly>`;
}

test("PE manifest policy accepts only one active asInvoker declaration", () => {
  assert.deepEqual(verifyAsInvokerManifestText(manifest("asInvoker")), {
    level: "asInvoker",
    uiAccess: "false"
  });
  assert.throws(() => verifyAsInvokerManifestText(manifest("requireAdministrator")), /not 'asInvoker'/);
  assert.throws(() => verifyAsInvokerManifestText(manifest("highestAvailable")), /not 'asInvoker'/);
  assert.throws(() => verifyAsInvokerManifestText(manifest("asInvoker", "true")), /uiAccess must be false/);
  assert.throws(() => verifyAsInvokerManifestText("<assembly />"), /found 0/);
  assert.throws(
    () => verifyAsInvokerManifestText(`${manifest("asInvoker")}${manifest("requireAdministrator")}`),
    /found 2/
  );
});

test("PE manifest policy ignores commented declarations instead of trusting them", () => {
  assert.throws(
    () => verifyAsInvokerManifestText(`<!-- ${manifest("asInvoker")} -->${manifest("requireAdministrator")}`),
    /not 'asInvoker'/
  );
});

test("the packaging Node executable has an authoritative asInvoker manifest", { skip: process.platform !== "win32" }, async () => {
  const result = await verifyAsInvokerExecutable(process.execPath);
  assert.equal(result.level, "asInvoker");
  assert.equal(result.uiAccess, "false");
  assert.ok(result.manifestCount >= 1);
});

test("Windows token verifier inspects elevation, integrity, and Administrators membership", { skip: process.platform !== "win32", timeout: 70_000 }, () => {
  const result = inspectWindowsStandardUserToken();
  assert.equal(typeof result.verified, "boolean");
  if (result.verified) {
    assert.equal(result.integrityRid, 0x2000);
    assert.equal(result.integrity, "medium");
    assert.equal(result.elevated, false);
    assert.equal(result.administratorsEnabled, false);
    if (result.administratorsPresent) assert.equal(result.administratorsDenyOnly, true);
  } else {
    assert.match(result.reason ?? "", /integrity|token|verification|process/i);
  }
});
