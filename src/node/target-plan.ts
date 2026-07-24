import { dirname, isAbsolute, resolve } from "node:path";
import type { CsvTarget } from "../core/model";
import type { ContractRunInput } from "./streaming-validator";

export interface TargetPlan {
  source: string;
  inputs: ContractRunInput[];
}

export function isHttpTarget(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolvePath(value: string, baseDirectory = process.cwd()): string {
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
}

export function resolveConfiguredTarget(specPath: string, target: CsvTarget): string {
  if (target.url !== undefined) {
    if (!isHttpTarget(target.url)) throw new Error(`Target URL must use HTTP or HTTPS: ${target.url}`);
    return new URL(target.url).toString();
  }
  if (target.path === undefined || target.path.trim() === "") {
    throw new Error(`Contract target in ${specPath} must declare a non-empty path or URL.`);
  }
  return resolvePath(target.path, dirname(specPath));
}

export function createTargetPlans(inputs: ContractRunInput[], explicitTargets: string[] = []): TargetPlan[] {
  const plans = new Map<string, TargetPlan>();
  const add = (source: string, input: ContractRunInput): void => {
    const key = isHttpTarget(source) ? new URL(source).toString() : resolve(source);
    const plan = plans.get(key) ?? { source: key, inputs: [] };
    if (!plan.inputs.some((candidate) => candidate.spec === input.spec)) plan.inputs.push(input);
    plans.set(key, plan);
  };

  if (explicitTargets.length > 0) {
    for (const rawTarget of explicitTargets) {
      const source = isHttpTarget(rawTarget) ? new URL(rawTarget).toString() : resolvePath(rawTarget);
      inputs.forEach((input) => add(source, input));
    }
  } else {
    for (const input of inputs) {
      const targets = input.contract.targets ?? [];
      if (targets.length === 0) {
        throw new Error(`Contract ${input.spec} has no targets. Add targets or pass --csv explicitly.`);
      }
      targets.forEach((target) => add(resolveConfiguredTarget(input.spec, target), input));
    }
  }

  return [...plans.values()];
}
