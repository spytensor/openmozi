---
name: data-analysis
description: "Data analysis workflow: ingest, validate quality, explore, analyze, report. Use when the user provides or references datasets (CSV, JSON, SQL, spreadsheets) or asks for statistics, aggregation, correlation, or chart generation."
version: "1.0.0"
category: utility
user-invocable: true
requires:
  bins: []
  env: []
install:
  # pandas ships with the managed document runtime; matplotlib does not, and this
  # skill's guidance below tells the model to use it. Declaring it here makes the
  # claim true through the managed provisioning path (architecture-keyed overlay,
  # binary wheels only, verified by import) instead of leaving the model to
  # discover the gap at runtime and pip-install it itself. Declared rather than
  # bundled so the App payload does not grow.
  - kind: pip
    package: matplotlib
    imports: ["matplotlib"]
    label: "Install matplotlib for chart generation"
metadata:
  priority: 60
---

# Data Analysis Workflow

## How to Execute
1. **Ingest**: Read the data source (CSV, JSON, database, API). Confirm format and size.
2. **Validate**: Check for missing values, outliers, type mismatches. Report data quality issues.
3. **Explore**: Compute basic statistics (count, mean, median, distribution). Identify patterns.
4. **Analyze**: Apply the requested analysis (correlation, aggregation, filtering, comparison).
5. **Report**: Present findings with clear summaries. Generate charts/visualizations if requested.

## Rules
- Always inspect the data before analyzing — never assume structure.
- Report data quality issues (nulls, duplicates, outliers) before drawing conclusions.
- Use shell_exec with Python (pandas, matplotlib) for large datasets or complex analysis.
- Show your methodology: what you computed, which columns, what filters.
- Present numbers with appropriate precision (don't show 15 decimal places).

## Pitfalls
- Analyzing without first inspecting the data shape and quality
- Drawing conclusions from data with unaddressed quality issues
- Showing raw numbers without context or interpretation
- Not specifying units or time periods for metrics
