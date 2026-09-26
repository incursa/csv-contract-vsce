import { parseContract } from "./contract";
import type { CsvContract } from "./model";
import type { SuiteIO } from "./suite";

export async function resolveGroupContracts(contract: CsvContract, source: string, io: SuiteIO,
  ancestors: string[] = [], depth = 0): Promise<CsvContract> {
  if (!contract.groupTests?.length) return contract;
  if (depth > 4) throw new Error("Group contract nesting exceeds four levels.");
  const canonical = await io.canonical?.(source) ?? source;
  if (ancestors.includes(canonical)) throw new Error(`Group contract reference cycle: ${[...ancestors, canonical].join(" -> ")}`);
  const nextAncestors = [...ancestors, canonical];
  const groups = await Promise.all((contract.groupTests ?? []).map(async group => {
    const childSource = group.ref ? io.resolve(source, group.ref) : source;
    const child = group.ref ? parseContract(await io.read(childSource)) : group.contract!;
    if (child.targets?.length || child.sqlServer) throw new Error(`Child contract ${group.id} must inherit the parent target.`);
    const resolved = await resolveGroupContracts(child, childSource, io,
      group.ref ? nextAncestors : ancestors, depth + 1);
    const copy = { ...group };
    if (group.ref) Object.defineProperty(copy, "resolvedContract", { value: resolved, enumerable: false });
    else copy.contract = resolved;
    Object.defineProperty(copy, "resolvedSource", { value: childSource, enumerable: false });
    return copy;
  }));
  return { ...contract, groupTests: groups };
}
