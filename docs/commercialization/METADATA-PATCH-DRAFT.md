# Proposed metadata patch (illustrative only)

> **DRAFT — NON-OPERATIVE. Do not apply without legal/product approval.**

This example shows the shape of a future manifest patch after an approved
boundary. It is not applied to `package.json`.

```diff
 {
   "name": "csv-contract-vsce",
   "version": "<approved-version>",
   "publisher": "incursa",
-  "license": "Apache-2.0",
+  "license": "SEE LICENSE IN PROPRIETARY-NOTICE.md",
   "repository": {
     "type": "git",
     "url": "<approved-private-repository-or-feed-url>"
   }
 }
```

The final representation must be checked against Marketplace manifest rules and
the selected customer grant. It must not change the extension ID, package name,
version history, or existing release records. Do not globally replace
Apache-2.0 references: prior versions and separately open schemas/fixtures may
require their current declarations.

If implementation artifacts move to a private package/feed arrangement,
separately document endpoint, restore authentication, cache behavior, package
retention, offline/reproducible restore, and Marketplace successor strategy.
No feed, credential, publication, or identifier change is authorized by this
draft.
