/* global console, process */
import { inspectWindowsStandardUserToken } from "./lib/windows-standard-user.mjs";

const result = inspectWindowsStandardUserToken();
if (!result.verified) {
  console.log(`Windows standard-user token: UNVERIFIED (${result.reason})`);
  process.exitCode = 2;
} else {
  console.log(`Windows standard-user token: PASS (${result.integrity} integrity; ${result.elevationType}, not elevated; Administrators SID not enabled)`);
}
