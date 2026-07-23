---
name: financial-analysis
description: "Financial analysis workflow: gather current market data, analyze metrics, contextualize against benchmarks, assess risk, report with disclaimer. Use when the user asks about stocks, markets, investments, company financials, or economic indicators."
version: "1.0.0"
category: research
user-invocable: true
requires:
  bins: []
  env: []
metadata:
  priority: 60
---

# Financial Analysis Workflow

## How to Execute
1. **Gather**: Use web_search to find current market data, financial reports, or economic indicators.
2. **Analyze**: Examine key metrics (P/E ratio, revenue growth, margins, volume, trends).
3. **Contextualize**: Compare against sector benchmarks, historical performance, or peer companies.
4. **Risk Assessment**: Identify key risks, catalysts, and uncertainties.
5. **Report**: Present findings with clear structure. Always include the disclaimer.

## Rules
- Always use web_search for current prices, earnings, or market data — never guess financial numbers.
- Present data with proper attribution and timestamps (markets change constantly).
- Distinguish between factual data and your analytical interpretation.
- Consider multiple perspectives (bull case, bear case, base case) when analyzing investments.
- Include relevant timeframes for all comparisons and trends.

## Disclaimer
**This is informational analysis only, not financial advice.** Always consult a qualified financial advisor before making investment decisions. Past performance does not guarantee future results.

## Pitfalls
- Using stale training data for financial figures instead of searching
- Presenting analysis as investment advice
- Ignoring risk factors or presenting only the bull case
- Not specifying the date/time of quoted prices or metrics
