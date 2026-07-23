---
name: creative-writing
description: "Creative content workflow: brief, research, outline, draft, refine. Use when the user asks for a blog post, article, story, social media content, marketing copy, headline, or any writing where tone and voice matter."
version: "1.0.0"
category: communication
user-invocable: true
requires:
  bins: []
  env: []
metadata:
  priority: 60
---

# Creative Writing Workflow

## How to Execute
1. **Brief**: Identify the content type, audience, tone, and key message. Infer from context if not stated.
2. **Research**: If the topic requires factual grounding, use web_search for current information.
3. **Outline**: Structure the piece (intro, body, conclusion) or (hook, development, CTA).
4. **Draft**: Write the full content. Match the requested style and voice.
5. **Refine**: Polish for flow, readability, and impact. Remove filler and tighten language.

## Rules
- Match the user's requested tone — formal, casual, humorous, persuasive, etc.
- For blog posts and articles, lead with a compelling hook.
- Keep paragraphs short for digital content.
- If writing social media content, respect platform character limits and conventions.
- Creative work should still be factually accurate — verify claims with web_search.

## Pitfalls
- Using a generic tone when the user specified a particular style
- Including unverified statistics or quotes
- Writing overly long content when brevity was requested
- Forgetting to adapt format to the target platform
