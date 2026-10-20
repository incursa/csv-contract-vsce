/* global Buffer */
import { readFile } from "node:fs/promises";

const RT_MANIFEST = 24;
const EXECUTABLE_MANIFEST_ID = 1;
const HIGH_BIT = 0x80000000;

function fail(message) { throw new Error(`Windows PE manifest verification failed: ${message}`); }
function u16(buffer, offset) { if (!Number.isSafeInteger(offset) || offset < 0 || offset + 2 > buffer.length) fail("truncated 16-bit field"); return buffer.readUInt16LE(offset); }
function u32(buffer, offset) { if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > buffer.length) fail("truncated 32-bit field"); return buffer.readUInt32LE(offset); }

function peLayout(buffer) {
  if (buffer.length < 64 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) fail("file is not a Windows MZ executable");
  const pe = u32(buffer, 0x3c);
  if (pe + 24 > buffer.length || buffer.toString("ascii", pe, pe + 4) !== "PE\0\0") fail("PE signature is missing");
  const sectionCount = u16(buffer, pe + 6);
  const optionalSize = u16(buffer, pe + 20);
  const optional = pe + 24;
  if (optional + optionalSize > buffer.length) fail("truncated optional header");
  const magic = u16(buffer, optional);
  const dataDirectory = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : fail("unsupported optional-header format"));
  if (optionalSize < dataDirectory - optional + 24) fail("optional header has no resource directory");
  const resourceRva = u32(buffer, dataDirectory + 16);
  const resourceSize = u32(buffer, dataDirectory + 20);
  if (!resourceRva || !resourceSize) fail("manifest resource directory is absent");

  const sectionTable = optional + optionalSize;
  if (sectionTable + sectionCount * 40 > buffer.length) fail("truncated section table");
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const entry = sectionTable + index * 40;
    sections.push({
      virtualSize: u32(buffer, entry + 8),
      virtualAddress: u32(buffer, entry + 12),
      rawSize: u32(buffer, entry + 16),
      rawOffset: u32(buffer, entry + 20)
    });
  }
  const offsetForRva = (rva, size = 1) => {
    if (!Number.isSafeInteger(size) || size < 0) fail("invalid resource size");
    const section = sections.find((item) => {
      if (rva < item.virtualAddress) return false;
      const delta = rva - item.virtualAddress;
      return delta <= item.rawSize && size <= item.rawSize - delta;
    });
    if (!section) fail(`RVA 0x${rva.toString(16)} is outside file-backed section data`);
    const offset = section.rawOffset + rva - section.virtualAddress;
    if (!Number.isSafeInteger(offset) || offset < 0 || size > buffer.length - offset) fail("resource points outside the executable");
    return offset;
  };
  return { resourceSize, resourceOffset: offsetForRva(resourceRva, resourceSize), offsetForRva };
}

function resourceRange(layout, relativeOffset, size, description) {
  if (!Number.isSafeInteger(relativeOffset) || relativeOffset < 0
    || !Number.isSafeInteger(size) || size < 0
    || relativeOffset > layout.resourceSize || size > layout.resourceSize - relativeOffset) {
    fail(`${description} is outside the resource directory`);
  }
  return layout.resourceOffset + relativeOffset;
}

function entries(buffer, layout, directoryOffset) {
  const directory = resourceRange(layout, directoryOffset, 16, "resource directory");
  const count = u16(buffer, directory + 12) + u16(buffer, directory + 14);
  const table = resourceRange(layout, directoryOffset + 16, count * 8, "resource entry table");
  return Array.from({ length: count }, (_, index) => {
    const offset = table + index * 8;
    const name = u32(buffer, offset);
    const target = u32(buffer, offset + 4);
    return { id: name & HIGH_BIT ? undefined : name, target: target & ~HIGH_BIT, directory: !!(target & HIGH_BIT) };
  });
}

function decodeManifest(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le").replace(/\0+$/, "");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(Math.max(0, bytes.length - 2));
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1];
      swapped[index - 1] = bytes[index];
    }
    return swapped.toString("utf16le").replace(/\0+$/, "");
  }
  return bytes.toString("utf8").replace(/^\uFEFF/, "").replace(/\0+$/, "");
}

/** Extract every language variant of executable RT_MANIFEST resource ID 1. */
export function extractWindowsPeManifests(buffer) {
  const layout = peLayout(buffer);
  const manifests = [];
  const types = entries(buffer, layout, 0).filter((entry) => entry.id === RT_MANIFEST && entry.directory);
  for (const type of types) {
    const names = entries(buffer, layout, type.target).filter((entry) => entry.id === EXECUTABLE_MANIFEST_ID && entry.directory);
    for (const name of names) {
      for (const language of entries(buffer, layout, name.target)) {
        if (language.directory) fail("manifest language entry unexpectedly points to a directory");
        const dataEntry = resourceRange(layout, language.target, 16, "manifest data entry");
        const dataRva = u32(buffer, dataEntry);
        const size = u32(buffer, dataEntry + 4);
        if (!size) fail("manifest resource is empty");
        const offset = layout.offsetForRva(dataRva, size);
        manifests.push({ languageId: language.id, manifest: decodeManifest(buffer.subarray(offset, offset + size)) });
      }
    }
  }
  if (!manifests.length) fail("executable RT_MANIFEST resource ID 1 is absent");
  return manifests;
}

/** Extract the first executable manifest for callers that only need its text. */
export function extractWindowsPeManifest(buffer) { return extractWindowsPeManifests(buffer)[0].manifest; }

function activeXml(manifest) {
  if (/<!DOCTYPE\b/i.test(manifest)) fail("DOCTYPE declarations are not allowed in the executable manifest");
  return manifest.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<\?[\s\S]*?\?>/g, "");
}

function attributeValues(attributes, name) {
  const values = [];
  const expression = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "gi");
  for (const match of attributes.matchAll(expression)) values.push(match[1]);
  return values;
}

export function verifyAsInvokerManifestText(manifest) {
  const tags = [...activeXml(manifest).matchAll(/<requestedExecutionLevel\b([^>]*)>/gi)];
  if (tags.length !== 1) fail(`expected exactly one active requestedExecutionLevel element; found ${tags.length}`);
  const levels = attributeValues(tags[0][1], "level");
  const uiAccessValues = attributeValues(tags[0][1], "uiAccess");
  if (levels.length !== 1) fail(`expected exactly one level attribute; found ${levels.length}`);
  if (uiAccessValues.length > 1) fail(`expected at most one uiAccess attribute; found ${uiAccessValues.length}`);
  const level = levels[0];
  const uiAccess = uiAccessValues[0];
  if (level !== "asInvoker") fail(`requested execution level is '${level}', not 'asInvoker'`);
  if (uiAccess !== undefined && uiAccess !== "false") fail("uiAccess must be false");
  return { level, uiAccess: uiAccess ?? "false" };
}

export async function verifyAsInvokerExecutable(path) {
  const manifests = extractWindowsPeManifests(await readFile(path));
  const verified = manifests.map(({ manifest }) => verifyAsInvokerManifestText(manifest));
  return { ...verified[0], manifest: manifests[0].manifest, manifestCount: manifests.length };
}
