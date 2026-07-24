# Changelog

## 0.3.0

- Added a native CSV Contract Activity Bar view that discovers contract files across every workspace folder.
- Added persistent checkboxes for selecting several contracts and a **Run Selected** workspace action.
- Grouped selected contracts by resolved target so shared CSV files are loaded once per workspace run.
- Added consolidated pass/fail reporting in the tree and CSV Contract output channel, including expandable diagnostics.
- Reported invalid contracts, missing configured targets, inaccessible files, and failed URL downloads alongside validation failures.
- Added installed-extension PowerShell usage to the end of the Marketplace README.

## 0.2.1

- Preserved an absolute Windows target path when a generated contract and its source CSV are on different drives.

## 0.2.0

- Added optional contract-level CSV targets using relative or absolute file paths and HTTP/HTTPS URLs.
- Added Workbench controls for saving multiple file paths or URLs, temporarily overriding them, and reviewing per-target results.
- Added automatic multi-file execution to the Command Palette, Node CLI, and PowerShell wrapper.
- Grouped contracts that reference the same CSV so compatible validations still share a streaming pass.
- Downloaded remote CSV targets incrementally to isolated temporary disk for bounded-memory batch validation.
- Updated contract generation to save the source CSV as a portable relative target.
- Added separate desktop and browser extension bundles so normal remote URLs are not constrained by browser CORS in VS Code desktop.

## 0.1.5

- Renamed the Workbench CSV picker to **Select test CSV** to make clear that selecting a validation target does not replace the existing contract or its tests.
- Updated the Marketplace instructions and screenshots to match the clearer workflow.

## 0.1.4

- Replaced low-contrast presence badges with readable required and optional labels.
- Added a bounded, sticky-header column scroller that preserves position for contracts with hundreds of columns.
- Kept the column inspector top aligned beside large column lists.
- Added complete visual editing for row selectors, match counts, and exact cell expectations.
- Added browser coverage for a 202-column contract, row/cell editing, and responsive overflow.

## 0.1.3

- Refined and enlarged the table-and-check mark for cleaner balance and stronger small-size legibility.
- Added deliberate negative space between the CSV grid and validation check across Marketplace, banner, wordmark, monochrome, and compact assets.
- Documented the approved refinement in the CSV Contract Figma design file and verified it at 256, 64, 32, and 16 pixels.

## 0.1.2

- Reworked the Marketplace overview around end-user workflows and validation capabilities.
- Added current workbench screenshots for column-rule authoring and validation-result review.
- Removed repository build, test, publishing, benchmark, and one-off batch details from the Marketplace README.

## 0.1.1

- Added the CSV table-and-check product mark in Marketplace, wordmark, README banner, monochrome, and compact icon variants.
- Added deterministic brand-asset rendering and verification scripts.
- Added separate Incursa brand asset and trademark terms.

## 0.1.0

- Added the visual CSV Contract Workbench custom editor.
- Added YAML JSON Schema IntelliSense.
- Added shared column, row, and cell validation.
- Added a single-pass streaming Node CLI and PowerShell validator with multiple-contract support, bounded diagnostics, progress reporting, and exact disk-backed uniqueness.
- Added a PowerShell contract-outline generator with safe overwrite handling and optional sample-bounded constraint inference.
- Added comprehensive positive and negative CSV fixtures, PowerShell 7 and Windows PowerShell 5.1 coverage, and large-file performance tooling.
- Added an AI-agent contract-authoring guide and reusable prompt.
- Added browser smoke tests, VSIX packaging, CI, and release automation.
