import type { CsvContract } from "./model";
export function identityKey(values: string[], identity: NonNullable<CsvContract["identity"]>, isNull: (value: string) => boolean): { key?: string; nullFailure: boolean } {
  const hasNull = values.some(isNull);
  if (hasNull && identity.nulls === "fail") return { nullFailure: true };
  if (identity.unique === false || hasNull && identity.nulls === "ignore") return { nullFailure: false };
  return { nullFailure: false, key: identity.nulls === "equal" ? JSON.stringify(values.map(v => isNull(v) ? ["null"] : ["value", v])) : values.map(v => `${v.length}:${v}`).join("") };
}
