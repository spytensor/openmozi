---
name: research-workflow
description: "Structured research workflow: decompose the question, search in parallel, cross-verify sources, synthesize with citations. Use when the user asks to research, investigate, compare, or survey a topic, or when an answer depends on facts that must be verified across multiple sources."
version: "1.0.0"
category: research
user-invocable: true
requires:
  bins: []
  env: []
metadata:
  priority: 60
---

# Research Workflow

## How to Execute
1. **Decompose**: Break the question into 2-5 sub-questions that can be researched independently.
2. **Search**: Use web_search for each sub-question. Parallelize independent searches.
3. **Cross-verify**: Check claims from multiple sources. Flag conflicting information.
4. **Synthesize**: Combine findings into a structured answer with citations.
5. **Qualify**: State confidence level and note gaps in available information.

## Rules
- Never rely on training data alone for factual claims — always verify with web_search.
- Prefer primary sources (official docs, papers, announcements) over secondary ones.
- When sources conflict, present both sides and explain the discrepancy.
- Include dates for time-sensitive information.
- Clearly separate facts from your analysis or interpretation.

## Freshness Self-Check (mandatory when the request says "latest", "recent", "最新", "近期", or implies now)
1. Anchor: read the current date from the runtime time facts — that is "now", not your training data.
2. Query with recency: include the current year (and month if relevant) in search queries; prefer provider recency filters when available.
3. Date every source: extract each result's publication date. A result without a discoverable date is weak evidence for a "latest" claim.
4. Compare before claiming: if the newest source you found is older than the request implies (e.g. a year-old report for a "latest report" request), say so explicitly — "the newest I could verify is X from <date>" — instead of presenting it as current.
5. If search is unavailable or returns nothing recent, state plainly what you could not verify. Never fill the gap from training data without labeling it as such.

## Pitfalls
- Presenting training data as verified fact
- Citing a single source without cross-checking
- Omitting publication dates on time-sensitive topics
- Mixing opinion with established fact
