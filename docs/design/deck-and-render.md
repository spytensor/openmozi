# Design — Web-first decks + artifact rendering

Decision (operator, 2026-07-04): "make me a PPT" defaults to a **beautiful
web deck** rendered live; exporting a real `.pptx` is a secondary action.
This mirrors how Claude/ChatGPT feel good — they render web-native content,
not converted Office files.

## Rendering strategy (validated)

Browsers cannot render pptx/docx/xlsx natively. Two lanes:

- **Web-native (primary, gorgeous):** html/react/svg/markdown render live in
  the artifact panel (mostly exists). Decks are HTML (16:9 slides).
- **Real Office files (secondary):** preview via **macOS QuickLook**
  (`qlmanage` — validated: renders our pptx to PNG with the OS engine, zero
  LibreOffice, perfect fidelity). Works from any macOS process incl.
  Electron. Non-macOS → file card + download, honestly no preview. soffice
  is only an optional last-resort fallback, not the default.

## Tracks

- **CX-RENDER-BE (now, src/):** given an office/pdf file inside allowed
  roots, produce preview image(s) via qlmanage; cache; serve; augment the
  file_v1 artifact with previewUrl when available. macOS-gated; honest
  no-preview elsewhere.
- **CX-RENDER-FE (after TURN-GROUP, ui/):** artifact panel previews inline
  — pdf/image/svg/html/md direct; office via the previewUrl image(s);
  download demoted to a secondary button.
- **CX-WEB-DECK (after SKILL-AESTHETIC, skills/):** the bundled `pptx` skill
  produces and edits real presentation files, with frontend-design principles
  still providing visual guidance for deck-like artifacts.
