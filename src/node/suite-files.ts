import { readFile, writeFile, realpath, mkdir, stat } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { isAlias, visit, Document } from "yaml";
import Ajv from "ajv/dist/2020";
import contractSchema from "../../schemas/csvtest.schema.json";
import { effectiveContract, loadSuite, parseSuite, yamlDocument, type SuiteIO, type SuiteConnection } from "../core/suite";
import type { CsvContract } from "../core/model";

export const fileSuiteIO: SuiteIO = {
  read: (path) => readFile(path, "utf8"),
  resolve: (containing, ref) => resolve(dirname(containing), ref),
  canonical: async (path) => { const actual = await realpath(path); return process.platform === "win32" ? actual.toLowerCase() : actual; }
};
const validateContract = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(contractSchema);
function checkConversion(doc: Document): void {
  visit(doc, (_, node) => {
    if (isAlias(node) || (node && typeof node === "object" && "anchor" in node && node.anchor)) throw new Error("Combine/split does not support YAML anchors or aliases; expand them explicitly first. No output was written.");
  });
}
function checkContract(value: unknown, id: string, defaults?: SuiteConnection): void {
  if (!validateContract(effectiveContract(value as CsvContract, defaults))) throw new Error(`${id}: unsupported or invalid contract content: ${JSON.stringify(validateContract.errors)}`);
  const scan = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    for (const [key, v] of Object.entries(item)) {
      if (/^(password|pwd|secret|token|connectionString|userId|username)$/i.test(key)) throw new Error(`${id}: credential field '${key}' cannot be bundled.`);
      if (key === "connection" && (typeof v !== "string" || !/^[A-Za-z0-9._-]+$/.test(v))) throw new Error(`${id}: connection must be a profile name.`);
      scan(v);
    }
  };
  scan(value);
}
function rebaseTargets(doc: Document, from: string, to: string): string[] {
  const value = doc.toJS();
  const dependencies: string[] = [];
  for (const [index, target] of (value.targets ?? []).entries()) {
    if (target.path) {
      const absolute = resolve(dirname(from), target.path);
      const path = relative(dirname(to), absolute);
      doc.setIn(["targets", index, "path"], (isAbsolute(path) ? absolute : path).split(sep).join("/"));
      dependencies.push(`local file: ${absolute}`);
    } else if (target.url) {
      const url = new URL(target.url);
      if (url.username || url.password || url.search) throw new Error("Portable contracts cannot contain authenticated or query-bearing URLs; supply them at runtime.");
      dependencies.push(`external URL: ${target.url}`);
    }
  }
  if (value.baseline?.ref) {
    const absolute = resolve(dirname(from), value.baseline.ref);
    doc.setIn(["baseline", "ref"], relative(dirname(to), absolute).split(sep).join("/") || absolute);
    dependencies.push(`schema baseline: ${absolute}`);
  }
  return dependencies;
}
function comparable(contract: CsvContract, source: string, defaults?: SuiteConnection): string {
  const copy = effectiveContract(contract, defaults);
  for (const target of copy.targets ?? []) if (target.path !== undefined) target.path = resolve(dirname(source), target.path);
  if (copy.baseline && "ref" in copy.baseline) copy.baseline.ref = resolve(dirname(source), copy.baseline.ref);
  return JSON.stringify(copy);
}
async function ensureWritable(paths: string[], force: boolean): Promise<void> {
  if (force) return;
  for (const path of paths) {
    try { await stat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    throw new Error(`Refusing to overwrite ${path}; use --force.`);
  }
}
export async function combineSuite(source: string, output: string, options: { force?: boolean; allowExternal?: boolean } = {}) {
  source = resolve(source); output = resolve(output);
  if (source.toLowerCase() === output.toLowerCase()) throw new Error("Choose an output different from the source suite.");
  const text = await readFile(source, "utf8");
  const suite = parseSuite(text);
  const loaded = await loadSuite(source, fileSuiteIO);
  const failed = loaded.members.filter((m) => m.error);
  if (failed.length) throw new Error(failed.map((m) => `${m.id}: ${m.error}`).join("\n"));
  const doc = yamlDocument(text);
  checkConversion(doc);
  const dependencies: string[] = [];
  for (const [index, member] of suite.members.entries()) {
    const memberSource = member.ref ? resolve(dirname(source), member.ref) : source;
    const contractDoc: Document = member.ref ? yamlDocument(await readFile(memberSource, "utf8")) : new Document();
    if (!member.ref) contractDoc.contents = doc.getIn(["members", index, "contract"], true) as Document["contents"];
    checkConversion(contractDoc);
    checkContract(contractDoc.toJS(), member.id, suite.defaults);
    dependencies.push(...rebaseTargets(contractDoc, memberSource, output).map((d) => `${member.id}: ${d}`));
    const content = contractDoc.contents!;
    if (contractDoc.commentBefore) content.commentBefore = [contractDoc.commentBefore, content.commentBefore].filter(Boolean).join("\n");
    if (contractDoc.comment) content.comment = [content.comment, contractDoc.comment].filter(Boolean).join("\n");
    doc.deleteIn(["members", index, "ref"]);
    doc.setIn(["members", index, "contract"], content);
  }
  if (dependencies.length && !options.allowExternal) throw new Error(`Bundle is not portable; dependencies remain (use --allow-external to preserve their locations):\n${dependencies.join("\n")}`);
  const rendered = doc.toString({ lineWidth: 0 });
  const roundTrip = parseSuite(rendered);
  for (const [index, member] of roundTrip.members.entries()) {
    if (comparable(member.contract!, output, suite.defaults) !== comparable(loaded.members[index].contract!, loaded.members[index].source)) {
      throw new Error(`${member.id}: YAML conversion changed contract semantics; no output was written.`);
    }
  }
  await ensureWritable([output], !!options.force);
  await writeFile(output, rendered, { flag: options.force ? "w" : "wx" });
  return { output, members: suite.members.length, portable: !dependencies.length, dependencies };
}
export async function splitSuite(source: string, directory: string, force = false) {
  source = resolve(source); directory = resolve(directory);
  const text = await readFile(source, "utf8");
  const suite = parseSuite(text);
  const doc = yamlDocument(text);
  checkConversion(doc);
  const files: { path: string; text: string }[] = [];
  for (const [index, member] of suite.members.entries()) {
    if (!member.contract) throw new Error(`${member.id}: split requires every member to be inline; combine first.`);
    checkContract(member.contract, member.id, suite.defaults);
    // Prefix avoids reserved Windows filenames and case-folded IDs cannot overwrite one another.
    const filename = `member-${index + 1}-${member.id}.csvtest.yaml`;
    const path = resolve(directory, filename);
    const contractDoc = new Document();
    contractDoc.contents = doc.getIn(["members", index, "contract"], true) as Document["contents"];
    rebaseTargets(contractDoc, source, path);
    const rendered = contractDoc.toString({ lineWidth: 0 });
    if (comparable(yamlDocument(rendered).toJS() as CsvContract, path, suite.defaults) !== comparable(member.contract, source, suite.defaults)) {
      throw new Error(`${member.id}: YAML conversion changed contract semantics; no output was written.`);
    }
    files.push({ path, text: rendered });
    doc.deleteIn(["members", index, "contract"]);
    doc.setIn(["members", index, "ref"], `./${filename}`);
  }
  const master = resolve(directory, `${suite.id}.csvsuite.yaml`);
  files.push({ path: master, text: doc.toString({ lineWidth: 0 }) });
  if (files.some((f) => f.path.toLowerCase() === source.toLowerCase())) throw new Error("Split would overwrite its source; choose another output directory.");
  await ensureWritable(files.map((f) => f.path), force);
  await mkdir(directory, { recursive: true });
  for (const file of files) await writeFile(file.path, file.text, { flag: force ? "w" : "wx" });
  return { master, files: files.map((f) => f.path) };
}
