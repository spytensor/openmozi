/**
 * Message builder — constructs user messages from incoming channel data.
 *
 * Two modes:
 * 1. buildUserMessage()          — text-only (for DB persistence & non-vision models)
 * 2. buildMultimodalUserMessage() — images inline as ContentPart[] (for vision-capable brains)
 *
 * IMPORTANT: The text produced by buildUserMessage() is persisted to conversation history.
 * Absolute paths to ephemeral temp files MUST NOT be embedded — they become
 * stale after restart and cause the LLM to call tools (e.g. analyze_image)
 * on missing files.  Use durable descriptions instead.
 */

import { analyzeImage } from '../capabilities/vision.js';
import type { IncomingMessage } from '../channels/telegram.js';
import type { ContentPart } from '../core/llm.js';
import pino from 'pino';
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';

const logger = pino({ name: 'mozi:message-builder' });

/**
 * Format turn-scoped context blocks that must be visible to the Brain but not
 * persisted as user message content.
 *
 * This is TURN context for the Brain, not user content — inject it into the
 * system prompt, NOT into buildUserMessage(). Embedding it in the user message
 * pollutes the persisted/displayed bubble and the auto-title.
 */
export function formatWorkspaceContext(msg: IncomingMessage): string | null {
  const blocks: string[] = [];
  const context = msg.workspaceContext;
  if (context?.rootPath) {
    const lines = ['Workspace Context (selected in Web UI):'];
    if (context.label) lines.push(`- Label: ${context.label}`);
    if (context.rootKind) lines.push(`- Kind: ${context.rootKind}`);
    if (context.gitBranch) lines.push(`- Git branch: ${context.gitBranch}`);
    lines.push(`- Root path: ${context.rootPath}`);
    blocks.push(lines.join('\n'));
  }

  const attachedFiles = msg.attachments
    ?.filter(att => typeof att.path === 'string' && att.path.trim().length > 0)
    .filter(att => att.type !== 'photo') // images go inline via the multimodal path
    ?? [];
  if (attachedFiles.length > 0) {
    const lines = ['Files the user uploaded THIS TURN — read/extract them to answer (do NOT ask the user to re-provide them):'];
    for (const att of attachedFiles) {
      const name = att.filename ?? basename(att.path);
      lines.push(`- ${name} → ${att.path}`);
    }
    lines.push(
      'These paths are inside your allowed workspace. Text files: read_file directly. ' +
      'Binary Office/PDF files (.pptx/.docx/.xlsx/.pdf) are NOT plain text — extract their text first via shell before analyzing, e.g. ' +
      '`pdftotext <file> -` for PDF, ' +
      '`python3 -c "from pptx import Presentation; print(chr(10).join(s.text for sl in Presentation(\'<file>\').slides for s in sl.shapes if s.has_text_frame))"` for PPTX, ' +
      '`python3 -c "import docx;print(chr(10).join(p.text for p in docx.Document(\'<file>\').paragraphs))"` for DOCX, ' +
      '`python3 -c "import openpyxl,sys;[print([c.value for c in r]) for r in openpyxl.load_workbook(\'<file>\').active.iter_rows()]"` for XLSX (python-pptx/python-docx/openpyxl/pdftotext are installed).'
    );
    blocks.push(lines.join('\n'));
  }

  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

/**
 * Build a text-only user message string from an IncomingMessage.
 * Used for DB persistence and when the brain model does not support vision.
 * Photos are pre-analyzed via a separate vision API call.
 */
export async function buildUserMessage(msg: IncomingMessage): Promise<string> {
  const parts: string[] = [];

  if (msg.replyToText) {
    parts.push(msg.replyToText);
  }

  // NOTE: workspace context is intentionally NOT added here — it is injected into
  // the system prompt for the turn (see handler). Keeping it out of the user
  // message keeps the persisted bubble and auto-title clean.

  const photoAttachments = msg.attachments?.filter(att => att.type === 'photo') ?? [];
  if (photoAttachments.length > 0) {
    const photoDescriptions: string[] = [];
    for (let i = 0; i < photoAttachments.length; i++) {
      const attachment = photoAttachments[i];
      const label = `Photo ${i + 1}`;
      try {
        const analysis = await analyzeImage(
          attachment.path,
          'Describe this photo concisely for chat context.',
          { tenantId: msg.tenantId, userId: msg.userId },
        );
        // Embed only the analysis text — the temp file path is ephemeral and must not be persisted.
        photoDescriptions.push(`${i + 1}. ${label}: ${analysis}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ chatId: msg.chatId, path: attachment.path, err: errMsg }, 'Photo auto-analysis failed');
        // Do NOT include absolute path — it will be stale after restart.
        photoDescriptions.push(`${i + 1}. ${label}: [photo received but auto-analysis unavailable]`);
      }
    }
    parts.push(`Current Photo Analysis (attached to this message):\n${photoDescriptions.join('\n')}`);
  }

  if (msg.text.trim().length > 0) {
    parts.push(msg.text);
  }

  const textAttachments = msg.attachments?.filter(att => typeof att.content === 'string' && att.content.length > 0) ?? [];
  for (const attachment of textAttachments) {
    const label = attachment.filename ?? basename(attachment.path);
    parts.push(`Attachment: ${label}\n\`\`\`\n${attachment.content}\n\`\`\``);
  }

  // NOTE: non-text media (documents, audio, video) are intentionally NOT described
  // in the persisted user message. Their paths + extraction guidance are injected
  // as turn context in the system prompt (see formatWorkspaceContext), so this
  // string stays clean for the displayed bubble and auto-title. The UI shows the
  // uploaded file as an attachment chip from the attachments array.

  return parts.join('\n\n');
}

/**
 * Build a multimodal user message with inline image data for vision-capable brain models.
 * Images are embedded as ContentPart[] so the Brain sees them directly — no pre-analysis needed.
 *
 * Returns ContentPart[] (multimodal) if images are present, or null if there are no images
 * (caller should use the plain text message instead).
 */
export function buildMultimodalUserMessage(msg: IncomingMessage): ContentPart[] | null {
  const photoAttachments = msg.attachments?.filter(att => att.type === 'photo') ?? [];
  if (photoAttachments.length === 0) return null;

  const parts: ContentPart[] = [];

  if (msg.replyToText) {
    parts.push({ type: 'text', text: msg.replyToText });
  }

  // Embed images inline — the Brain sees them directly
  for (let i = 0; i < photoAttachments.length; i++) {
    const attachment = photoAttachments[i];
    let imageBytes: Buffer | undefined = attachment.bytes;
    if (!imageBytes) {
      // Fallback: read from disk if bytes weren't carried through
      try {
        imageBytes = readFileSync(attachment.path);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ path: attachment.path, err: errMsg }, 'Failed to read image file for multimodal message');
        parts.push({ type: 'text', text: `[Photo ${i + 1}: file read failed]` });
        continue;
      }
    }
    parts.push({ type: 'image', image: imageBytes, mediaType: attachment.mime });
  }

  if (msg.text.trim().length > 0) {
    parts.push({ type: 'text', text: msg.text });
  }

  // Text attachments
  const textAttachments = msg.attachments?.filter(att => typeof att.content === 'string' && att.content.length > 0) ?? [];
  for (const attachment of textAttachments) {
    const label = attachment.filename ?? basename(attachment.path);
    parts.push({ type: 'text', text: `Attachment: ${label}\n\`\`\`\n${attachment.content}\n\`\`\`` });
  }

  // Non-text media paths + extraction guidance are injected as turn context in
  // the system prompt (see formatWorkspaceContext), not embedded here.

  return parts;
}
