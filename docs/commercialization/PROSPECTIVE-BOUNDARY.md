# Prospective implementation-license boundary

> **DRAFT — NON-OPERATIVE. Approval and legal review are required.**

## Current baseline

- Repository: `incursa/csv-contract-vsce` (currently public).
- Extension identity: `incursa.csv-contract-vsce`; manifest name
  `csv-contract-vsce`; current checked-out version is `0.27.0`.
- The repository currently declares Apache-2.0 and includes `LICENSE`,
  `NOTICE`, brand-asset, and trademark material. None is changed by this draft.
- Existing Marketplace/GitHub-release versions retain their prior grants and
  availability decisions. Unknown feed or mirror history is unknown, not
  unpublished.

## Proposed future split

| Surface | Proposal for review | Open decision |
| --- | --- | --- |
| Future official extension/desktop/unattended/server implementation | Proprietary from `<approved-commit>` / `<approved-version>` | owner, exact boundary, customer grant |
| Specification/language documentation | Openly usable | license and canonical home |
| JSON schemas and compatibility identifiers | Openly usable | license, stable URLs, migration plan |
| Evidence/report interchange formats | Openly usable | license and versioning policy |
| Selected synthetic conformance fixtures | Openly usable | fixture inventory and license |
| Docs, prompts, examples, tests, icons, generated output | Case-by-case | ownership, brand, and dependency review |

The implementation/schema split must be explicit. The extension currently
references branch-based raw GitHub schema URLs and is consumed by other Incursa
tools; changing visibility without a compatibility host or migration would
break downstream resolution.

## Retained obligations

Inventory direct and transitive dependency licenses, packaged files, generated
assets, fonts, icons, and notices before approval. Preserve required
attributions and third-party materials. Do not use a proprietary notice to
override earlier Apache-2.0 grants or reserved brand/trademark rights.

## Acceptance evidence for a future change

- ownership/assignment record for each affected file family;
- exact commit/version boundary and reproducible package inventory;
- reviewed Marketplace/package metadata and notice;
- private-feed restore/build/test evidence without publication credentials; and
- legal approval of the notice, grant, and customer terms.
