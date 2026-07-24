# Performance evidence

`latest.json` is the latest committed large-file benchmark result. Reproduce it with:

```powershell
.\scripts\Test-CsvContractPerformance.ps1 -Rows 500000 -Columns 100
```

Generated benchmark CSV files and uniqueness temporary files are intentionally ignored.
