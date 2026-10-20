import test from "node:test";
import assert from "node:assert/strict";
import { isValidationContractPath, isValidationDefinitionPath, isValidationSuitePath } from "../src/core/validation-files";

test("recognizes generic and legacy validation definition names", () => {
  for (const path of ["rules.validation.yaml", "rules.validation.yml", "rules.csvtest.yaml", "rules.csvtest.yml"]) {
    assert.equal(isValidationContractPath(path), true, path);
    assert.equal(isValidationDefinitionPath(path), true, path);
  }
  for (const path of ["all.validationsuite.yaml", "all.validationsuite.yml", "all.csvsuite.yaml", "all.csvsuite.yml"]) {
    assert.equal(isValidationSuitePath(path), true, path);
    assert.equal(isValidationDefinitionPath(path), true, path);
  }
  assert.equal(isValidationDefinitionPath("rules.yaml"), false);
  assert.equal(isValidationSuitePath("rules.validation.yaml"), false);
  assert.equal(isValidationContractPath("all.validationsuite.yaml"), false);
});
