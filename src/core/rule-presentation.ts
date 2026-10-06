import type { ValidationIssue } from "./model";

export interface RulePresentation {
  id: string;
  name?: string;
  message?: string;
  importance?: number;
}

/** Preserve a plain-language message without discarding the validator's precise explanation. */
export function rulePresentation(rule: RulePresentation, diagnostic: string): Pick<ValidationIssue, "title" | "message" | "diagnostic"> {
  return {
    title: rule.name,
    message: rule.message?.trim() || diagnostic,
    ...(rule.message?.trim() ? { diagnostic } : {})
  };
}
