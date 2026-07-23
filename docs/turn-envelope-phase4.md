# Turn Envelope Phase 4 — User-facing presentation

Issue #628 makes the server-owned Turn Envelope carry presentation language and
uses that contract to keep Web and App activity UI understandable, accessible,
and responsive in long sessions.

## Authoritative locale

- `handleMessage` infers `en` or `zh-CN` once from the interactive prompt.
- Background delivery infers it from the delivered text.
- `session_turns.locale` persists the value; the additive migration leaves legacy
  rows `NULL` and does not rewrite history.
- Every live lifecycle transition broadcasts a `turn_envelope` WebSocket frame.
  The UI upserts that frame immediately, so a new turn does not wait for refresh.
- Timeline restore returns the same field. Character scanning remains only as a
  compatibility fallback for legacy rows with no locale.

Chinese prompts therefore keep Chinese activity labels even when tools return
English text, and English prompts remain English even if tool output contains Han
characters.

## Normal and technical disclosure

The collapsed/live surface uses localized semantic actions such as “Searching”
and “Loading skill”. Raw tool and skill identifiers are not shown there. Concrete
skill names, URLs, technical failure details, durations, and individual steps stay
available only after the user deliberately expands the execution block.

## Accessibility

- One `role=status`, `aria-live=polite` region announces coarse phase changes.
- Approval wait is derived from the durable `awaiting_approval` envelope rather
  than adjacency to the last low-level event.
- The conversation rail follows the ARIA feed pattern. Articles expose set size
  and position and support Up/Down/Home/End navigation without intercepting keys
  from nested buttons or links.

## Long-session budget

- Deterministic projection is memoized and execution blocks are memoized.
- Sessions longer than 160 render rows mount only a contiguous recent window,
  aligned to an authoritative turn boundary for user and background turns.
- Switching sessions collapses an expanded history window again.
- A deterministic 500-turn projection benchmark requires a median below 120 ms.
- A React/jsdom 500-background-turn test requires at most 161 mounted rows and a
  generous 1.5 s render ceiling; the latest turn must remain mounted.

## Channel boundary

Telegram and other channels already share `handleMessage`, so their turns receive
the same persisted locale and lifecycle truth. Telegram progress does not consume
the rich Web timeline or the new WebSocket frame; building a rich Telegram
timeline remains deliberately out of scope.
