/* global console, process */
import { verifyAsInvokerExecutable } from "./lib/windows-pe-manifest.mjs";

const path = process.argv[2];
if (!path) throw new Error("Usage: node scripts/verify-windows-pe-manifest.mjs <windows.exe>");
const result = await verifyAsInvokerExecutable(path);
console.log(`Windows PE manifest: PASS (${result.level}, uiAccess=${result.uiAccess})`);
