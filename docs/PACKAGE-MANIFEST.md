# Validation package manifest

Every JSON, CSV, and Excel validation export carries the `incursa.csv-contract-package` manifest model. The machine-readable package schema version is `1` (`packageSchemaVersion: "1"`). Excel repeats the manifest as rows in its reviewer-facing `Read Me` sheet.

The manifest identifies the contract or suite, a deterministic definition fingerprint, the completed run, selected scope, stable target/source labels, evidence-retention settings, sampling/truncation state, and completeness notices. Definition fingerprints are calculated from canonicalized effective definitions; connection credentials, connection strings, passwords, tokens, and secret/key fields are excluded.

`truncated` means the validator reported more issue events than it retained as details. `sampled` means evaluation intentionally covered a selected sample. Either condition makes `evidence.complete` false and adds a fixed completeness notice. Evaluation timestamps and export timestamps are the only expected time-varying metadata.
