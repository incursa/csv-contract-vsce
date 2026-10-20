export const validationContractPattern = /\.(?:csvtest|validation)\.ya?ml$/i;
export const validationSuitePattern = /\.(?:csvsuite|validationsuite)\.ya?ml$/i;
export const validationDefinitionPattern = /\.(?:csvtest|validation|csvsuite|validationsuite)\.ya?ml$/i;
export const validationWorkspaceGlob = "**/*.{csvtest,validation,csvsuite,validationsuite}.{yaml,yml}";

export function isValidationContractPath(path: string): boolean {
  return validationContractPattern.test(path);
}

export function isValidationSuitePath(path: string): boolean {
  return validationSuitePattern.test(path);
}

export function isValidationDefinitionPath(path: string): boolean {
  return validationDefinitionPattern.test(path);
}
