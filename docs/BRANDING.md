# CSV Contract Workbench branding

The CSV Contract Workbench mark combines a table frame, one column division, and row divisions with an open lower-right corner that resolves into a validation check. It uses the same Incursa indigo family and rounded construction as SpecTrace while remaining a distinct product symbol.

## Asset inventory

| Asset | Size or format | Intended use |
| --- | --- | --- |
| `images/icon.png` | 256×256 PNG | Visual Studio Marketplace and primary product icon |
| `images/icon-128.png` | 128×128 PNG | High-density application surfaces |
| `images/icon-64.png` | 64×64 PNG | Extension and documentation surfaces |
| `images/icon-32.png` | 32×32 PNG | Compact UI |
| `images/icon-16.png` | 16×16 PNG | Minimum-size legibility check |
| `images/csv-contract-icon.svg` | 256×256 SVG | Editable master for the full-color product icon |
| `images/csv-contract-wordmark-vscode.svg` | SVG | Product wordmark with the VS Code descriptor |
| `images/csv-contract-readme-banner.svg` | 960×220 SVG | Editable README banner master |
| `images/csv-contract-readme-banner.png` | 960×220 PNG | README and release documentation |
| `resources/csv-contract.svg` | 64×64 SVG | Theme-aware monochrome mark using `currentColor` |
| `artifacts/brand/csv-contract-brand-sheet.*` | 1200×720 SVG and PNG | Visual reference for the approved system |

## Colors

| Role | Value |
| --- | --- |
| Incursa Indigo | `#4459C6` |
| Deep Indigo | `#2B397F` |
| Workbench Ink | `#2A3142` |
| Primary text | `#121316` |
| Highlight surface | `#EEF1FF` |

## Rebuild and verify

The PNGs are deterministic browser renders of the tracked SVG masters:

```powershell
npm run brand:build
npm run brand:verify
```

`brand:verify` checks every PNG dimension, the Marketplace icon declaration, README references, brand terms, and the theme-aware monochrome SVG. It also runs as part of `npm run release:check`.

## Usage

- Use `images/icon.png` for Marketplace or other square product listings.
- Use the closest pre-rendered compact size instead of browser-downscaling the 256px PNG.
- Use `resources/csv-contract.svg` where the host controls foreground color.
- Preserve the clear space established by the rounded-square icon.
- Do not recolor, distort, rotate, rearrange, or separate the table and check.

See [`BRAND-ASSET-LICENSE.md`](../BRAND-ASSET-LICENSE.md) and [`TRADEMARKS.md`](../TRADEMARKS.md) for the separate terms that apply to these source-identifying assets.
