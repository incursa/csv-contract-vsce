# SQL baseline relationship and index metadata

SQL schema capture records columns plus two permission-aware catalog collections under `sqlMetadata`:

- `foreignKeys` contains the local schema/table, referenced schema/table, ordered local-to-referenced column pairs, and update/delete actions.
- `indexes` contains ordered key columns and direction, ordered included columns, uniqueness, disabled state, and the filtered-index predicate.

Each collection is explicitly marked `available` with `items`, or `unavailable`. An available empty list means SQL Server metadata was visible and no objects existed. `unavailable` means the connection could not prove the collection, so comparison reports `unknown:foreignKeys` or `unknown:indexes` instead of treating it as deletion or success.

Foreign-key capture uses left joins for referenced objects and columns. If the parent table is visible but referenced-side metadata is hidden by asymmetric permissions, the foreign-key collection is marked `unavailable`; it is never collapsed into a partial or empty available list.

Baselines created before these fields existed remain compatible. If `sqlMetadata` or one of its collections is absent from the expected baseline, that collection is not asserted and cannot create drift. Once a collection is captured as available, later permission loss is visible as unknown metadata.

Capture reads only SQL Server system catalogs. Schema and table names are bound parameters, and capture does not read table rows or execute application procedures.
