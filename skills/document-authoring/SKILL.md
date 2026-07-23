---
name: document-authoring
description: "Document and office-output workflow: clarify audience, ingest sources, outline, draft, review. Use when the user asks for a report, summary, email draft, memo, presentation, or any structured document deliverable."
version: "1.0.0"
category: communication
user-invocable: true
requires:
  bins: []
  env: []
metadata:
  priority: 60
---

# Document Authoring Workflow

## How to Execute
1. **Clarify**: Confirm document type, audience, and purpose. If ambiguous, pick the most common interpretation and proceed.
2. **Ingest**: Read any source materials (files, URLs, data). Extract key points.
3. **Structure**: Outline the document with sections and key headings before drafting.
4. **Draft**: Write the full document. Use appropriate formatting for the output type (markdown, plain text, slides).
5. **Review**: Check for completeness, accuracy, tone, and formatting consistency.

## Rules
- Match tone to audience (formal for reports, concise for emails, structured for presentations).
- For summaries, capture the core message in the first paragraph.
- Keep formatting consistent throughout the document.
- If producing files (PPT, PDF), use shell_exec with appropriate libraries (python-pptx, etc.).
- Back up existing files before overwriting.

## Pitfalls
- Starting to write without reading source materials
- Inconsistent formatting or tone within a document
- Over-padding with filler text instead of substance
- Not verifying that generated files open correctly
