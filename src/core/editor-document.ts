import { isMap, isSeq, type Document, type Node } from "yaml";
import { parseContract } from "./contract";
import { parseSuite, yamlDocument } from "./suite";
import type { CsvContract } from "./model";

/** Resolve by stable member identity on every edit, even after suite reordering. */
export function contractPath(text: string, memberId?: string): (string | number)[] {
  if (memberId === undefined) return [];
  const index = parseSuite(text).members.findIndex((m) => m.id === memberId && m.contract);
  if (index < 0) throw new Error(`Inline member '${memberId}' was removed or changed to a reference.`);
  return ["members", index, "contract"];
}

export function readEditorContract(text: string, memberId?: string): CsvContract {
  const doc = yamlDocument(text);
  const path = contractPath(text, memberId);
  const value = path.length ? doc.getIn(path, true) : doc.contents;
  return parseContract(String(value));
}

/** Reconcile semantic changes while retaining untouched YAML nodes and comments. */
function reconcile(doc: Document, node: unknown, value: unknown): Node {
  if (isMap(node) && value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const pair of [...node.items]) if (!(String(pair.key) in object)) node.delete(String(pair.key));
    for (const [key, child] of Object.entries(object)) node.set(key, reconcile(doc, node.get(key, true), child));
    return node;
  }
  if (isSeq(node) && Array.isArray(value)) {
    const old = [...node.items];
    node.items = value.map((child, index) => {
      const existing = child && typeof child === "object" && "id" in child
        ? old.find((item) => isMap(item) && item.get("id") === child.id) : old[index];
      return reconcile(doc, existing, child);
    });
    return node;
  }
  if (node && JSON.stringify((node as Node).toJSON()) === JSON.stringify(value)) return node as Node;
  return doc.createNode(value);
}

export function updateEditorContract(text: string, contract: CsvContract, memberId?: string): string {
  const clean = JSON.parse(JSON.stringify(contract)) as CsvContract;
  parseContract(JSON.stringify(clean));
  const doc = yamlDocument(text);
  const path = contractPath(text, memberId);
  const next = reconcile(doc, path.length ? doc.getIn(path, true) : doc.contents, clean);
  if (path.length) doc.setIn(path, next); else doc.contents = next as typeof doc.contents;
  return doc.toString({ lineWidth: 0 });
}

export function ruleOffset(text: string, id: string, memberId?: string): number | undefined {
  const doc = yamlDocument(text), prefix = contractPath(text, memberId);
  for (const suffix of [["rules"], ["rowTests"], ["groupRules"], ["sqlServer", "conditionalRules"]]) {
    const rules = doc.getIn([...prefix, ...suffix], true);
    if (!isSeq(rules)) continue;
    for (const node of rules.items) if (isMap(node) && node.get("id") === id) return node.range?.[0];
  }
  return undefined;
}
