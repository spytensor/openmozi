/**
 * Reading-surface typography specs (docs/DESIGN.md "Chat Prose"). Final
 * answers and Markdown documents use the primary classes below; process text
 * and legacy README surfaces retain the quieter original classes.
 *
 * The base body ink is set by the CALLER (chat answers /82, folded narration
 * /70) — never here, or the muted variant could not override it.
 *
 * Changing these values means amending the DESIGN.md section in the same PR.
 * Do NOT reintroduce Tailwind Typography (`prose prose-invert …`) as a
 * substitute: the plugin was never registered in tailwind.config, so those
 * classes silently generate zero CSS — three surfaces shipped as walls of
 * 14px preflight-reset text before this module unified them (2026-07-19).
 */
const CHAT_PROSE_SHARED =
  "[&_strong]:font-semibold " +
  "[&_h1]:text-ink/95 [&_h2]:text-ink/95 [&_h3]:text-ink/90 [&_h4]:text-ink/90 " +
  "[&_pre]:bg-[var(--code-bg)] [&_pre]:border [&_pre]:border-ink/[0.06] [&_pre]:rounded-lg [&_pre]:p-3.5 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_pre]:font-mono " +
  "[&_code]:text-code [&_code]:text-xs [&_code]:font-mono " +
  "[&_p]:my-[0.9em] [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-[0.8em] [&_ol]:my-[0.8em] [&_ul]:pl-[1.35em] [&_ol]:pl-[1.35em] [&_li]:my-[0.35em] [&_li>p]:my-[0.4em] [&_li>ul]:my-[0.4em] [&_li>ol]:my-[0.4em] " +
  // Tailwind preflight strips list markers app-wide; a reading surface needs
  // them back (muted, so bullets don't shout louder than their text).
  "[&_ul]:list-disc [&_ol]:list-decimal [&_li]:marker:text-ink/35 " +
  "[&_a]:text-link hover:[&_a]:text-link-hover [&_a]:underline [&_a]:underline-offset-2 " +
  "[&_h1]:text-[21px] [&_h1]:font-semibold [&_h1]:leading-[1.35] [&_h1]:mt-[1.6em] [&_h1]:mb-[0.55em] [&_h1:first-child]:mt-0 " +
  "[&_h2]:text-[19px] [&_h2]:font-semibold [&_h2]:leading-[1.38] [&_h2]:mt-[1.6em] [&_h2]:mb-[0.55em] [&_h2:first-child]:mt-0 " +
  "[&_h3]:text-[16.5px] [&_h3]:font-semibold [&_h3]:leading-[1.45] [&_h3]:mt-[1.5em] [&_h3]:mb-[0.5em] [&_h3:first-child]:mt-0 " +
  "[&_h4]:text-[15px] [&_h4]:font-semibold [&_h4]:leading-[1.5] [&_h4]:mt-[1.4em] [&_h4]:mb-[0.45em] [&_h4:first-child]:mt-0 " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-ink/20 [&_blockquote]:pl-3 [&_blockquote]:text-ink/50 " +
  "[&_hr]:my-6 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-ink/10 " +
  "[&_table]:my-4 [&_table]:block [&_table]:w-fit [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:rounded-lg [&_table]:border [&_table]:border-ink/10 [&_table]:text-[13px] [&_table]:leading-[1.55] " +
  "[&_thead]:bg-ink/[0.04] [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:border-ink/10 [&_th]:px-3.5 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-ink/60 " +
  "[&_td]:border-b [&_td]:border-ink/[0.05] [&_td]:px-3.5 [&_td]:py-2 [&_td]:text-ink/70 [&_td]:tabular-nums [&_tbody_tr:nth-child(even)_td]:bg-ink/[0.02] [&_tr:last-child_td]:border-b-0";

export const CHAT_PROSE_CLASS = `text-[15px] leading-[1.75] max-w-none ${CHAT_PROSE_SHARED}`;

/**
 * Primary answer typography. This deliberately does not replace
 * CHAT_PROSE_CLASS: the latter is still consumed by skill/readme surfaces and
 * by subordinate turn narration. The operator-approved 2026-07-20 pass is
 * limited to final assistant answers and Markdown artifacts.
 *
 * These rules are a Tailwind transcription of @lobehub/ui 5.15.5's MIT-
 * licensed Markdown typography. Keeping MOZI's renderer preserves its heading
 * ids, links, table normalization and print wiring while matching Lobe's real
 * chat/document scale instead of approximating it from screenshots.
 */
const READING_PROSE_SHARED =
  "w-full max-w-full break-words px-px " +
  "[&_strong]:font-semibold [&_strong]:text-ink/[0.92] " +
  "[&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-bold [&_h4]:font-bold [&_h5]:font-bold [&_h6]:font-bold " +
  "[&_h1]:leading-[1.25] [&_h2]:leading-[1.25] [&_h3]:leading-[1.25] [&_h4]:leading-[1.25] [&_h5]:leading-[1.25] [&_h6]:leading-[1.25] " +
  "[&_h1]:text-ink/95 [&_h2]:text-ink/95 [&_h3]:text-ink/[0.92] [&_h4]:text-ink/90 [&_h5]:text-ink/90 [&_h6]:text-ink/90 " +
  "[&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-ink/[0.08] [&_pre]:bg-[var(--code-bg)] [&_pre]:p-3.5 [&_pre]:font-mono [&_pre]:text-[0.85em] " +
  "[&_code]:mx-[0.25em] [&_code]:inline [&_code]:rounded-[0.25em] [&_code]:border [&_code]:border-ink/[0.08] [&_code]:bg-ink/[0.04] [&_code]:px-[0.4em] [&_code]:py-[0.2em] [&_code]:font-mono [&_code]:text-[0.875em] [&_code]:leading-none [&_code]:text-code " +
  "[&_pre_code]:m-0 [&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[1em] [&_pre_code]:[line-height:inherit] " +
  "[&_p]:my-1 [&_p]:[line-height:inherit] [&_p]:tracking-[0.02em] [&_p:not(:first-child)]:mt-[0.5em] [&_p:not(:last-child)]:mb-[0.5em] " +
  "[&_ul]:ml-[1em] [&_ol]:ml-[1em] [&_ul]:list-none [&_ol]:list-decimal [&_ul]:pl-0 [&_ol]:pl-0 " +
  "[&_li]:my-[0.33em] [&_ul>li]:relative [&_ul>li]:ml-[1em] [&_ol>li]:ml-[1em] [&_ul>li]:before:absolute [&_ul>li]:before:-ml-[1em] [&_ul>li]:before:opacity-50 [&_ul>li]:before:content-['-'] " +
  "[&_a]:text-link hover:[&_a]:text-link-hover " +
  "[&_blockquote]:mx-0 [&_blockquote]:border-l-4 [&_blockquote]:border-ink/[0.16] [&_blockquote]:px-[1em] [&_blockquote]:py-0 [&_blockquote]:text-ink/[0.62] " +
  "[&_hr]:w-full [&_hr]:border-0 [&_hr]:border-b [&_hr]:border-dashed [&_hr]:border-ink/[0.14] " +
  "[&_table]:block [&_table]:w-max [&_table]:max-w-full [&_table]:border-collapse [&_table]:text-left [&_table]:text-pretty " +
  "[&_thead]:bg-ink/[0.04] [&_tr]:border-b [&_tr]:border-ink/[0.08] [&_tr:last-child]:border-b-0 " +
  "[&_th]:min-w-[120px] [&_th]:px-[1em] [&_th]:py-[0.75em] [&_th]:text-left [&_th]:font-semibold [&_th]:text-ink/[0.78] " +
  "[&_td]:min-w-[120px] [&_td]:px-[1em] [&_td]:py-[0.75em] [&_td]:text-left [&_td]:align-top [&_td]:text-ink/[0.76] [&_td]:tabular-nums " +
  "[&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-lg [&_img]:shadow-[0_0_0_1px_rgba(var(--ink-rgb),0.08)] " +
  "[&_h1]:scroll-mt-6 [&_h2]:scroll-mt-6 [&_h3]:scroll-mt-6 [&_h4]:scroll-mt-6 [&_h5]:scroll-mt-6 [&_h6]:scroll-mt-6 " +
  "[&_h1:focus]:outline-none [&_h2:focus]:outline-none [&_h3:focus]:outline-none [&_h4:focus]:outline-none [&_h5:focus]:outline-none [&_h6:focus]:outline-none";

export const CHAT_ANSWER_PROSE_CLASS =
  `text-[14px] leading-[1.6] text-ink/[0.86] ${READING_PROSE_SHARED} ` +
  "[&_h1]:my-[14px] [&_h2]:my-[14px] [&_h3]:my-[14px] [&_h4]:my-[14px] [&_h5]:my-[14px] [&_h6]:my-[14px] " +
  "[&_h1]:text-[19.25px] [&_h2]:text-[17.5px] [&_h3]:text-[15.75px] [&_h4]:text-[14.875px] [&_h5]:text-[14px] [&_h6]:text-[14px] " +
  "[&_ul]:my-[0.5em] [&_ol]:my-[0.5em] [&_ul]:!list-disc [&_ul>li]:before:hidden [&_li]:marker:text-ink/45 " +
  "[&_blockquote]:my-[0.5em] [&_hr]:my-[1.5em] [&_.markdown-table-frame]:my-[0.5em] [&_img]:my-[0.5em]";

export const DOCUMENT_PROSE_CLASS =
  `text-[15px] leading-[1.7] text-ink/[0.86] ${READING_PROSE_SHARED} ` +
  "[&_h1]:my-[15px] [&_h2]:my-[15px] [&_h3]:my-[15px] [&_h4]:my-[15px] [&_h5]:my-[15px] [&_h6]:my-[15px] " +
  "[&_h1]:text-[30px] [&_h2]:text-[24px] [&_h3]:text-[20px] [&_h4]:text-[17px] [&_h5]:text-[15px] [&_h6]:text-[15px] " +
  "[&_table]:!w-full [&_ul]:my-[0.85em] [&_ol]:my-[0.85em] [&_blockquote]:my-[0.85em] [&_hr]:my-[2.25em] [&_.markdown-table-frame]:my-[0.85em] [&_img]:my-[0.85em]";

/**
 * Subordinate variant for PROCESS text inside the turn fold (查看处理过程).
 * Same markdown treatment, one step down in size — process narration must not
 * read at answer size or the capsule has no hierarchy against the reply
 * (operator report 2026-07-19: "胶囊里面的字体太大").
 */
export const CHAT_PROSE_COMPACT_CLASS = `text-[13px] leading-[1.7] max-w-none ${CHAT_PROSE_SHARED}`;
