# Suite SQL target policy

SQL Server targets can declare a stable `id` and an explicit `environment`. Environment names are extensible identifiers such as `dev`, `prod`, or `qa`; the Workbench never infers an environment from a server or connection name.

```yaml
sqlServer:
  targets:
    - id: payroll-dev
      environment: dev
      enabled: true
      connection: payroll-dev
      schema: dbo
      table: Payroll
    - id: payroll-prod
      environment: prod
      enabled: false
      connection: payroll-prod
      schema: dbo
      table: Payroll
```

A suite may choose target state by environment without changing its child contracts:

```yaml
suiteVersion: 1
id: payroll-production
targetPolicy:
  sqlServer:
    environments:
      dev: false
      prod: true
members:
  - id: payroll
    ref: ./payroll.csvtest.yaml
    targetOverrides:
      - target: payroll-prod
        enabled: false
```

Effective enablement uses this precedence:

1. Member `targetOverrides` entry.
2. Suite environment policy.
3. Contract target `enabled` value.
4. Enabled by default.

Target IDs must be unique within one contract. Different members may reuse an ID. An override for an unknown target ID is invalid. Policies are runtime-only: referenced and inline child definitions are cloned, not modified. Disabled suite targets remain in the run report with `SKIPPED` status and enablement provenance. If every SQL target is disabled, the suite returns a non-successful skipped result without opening a database connection.

`targetMatrix` remains independent: it selects named targets for cross-check expansion after the same suite policy has been applied.
