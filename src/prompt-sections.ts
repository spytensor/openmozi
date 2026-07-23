export const PROMPT_SECTION_SEPARATOR = '\n\n---\n\n';

export const AVAILABLE_TOOLS_SECTION_HEADING = '## Available Tools';
export const AVAILABLE_TOOLS_SOURCE_INSTRUCTION = 'Use these tools when the user asks.';
export const AVAILABLE_TOOLS_SHAPED_INSTRUCTION = 'Use only these currently exposed tools.';
export const RUNTIME_CAPABILITY_SECTION_HEADING = '## Runtime Capability Contract (Authoritative)';

export function formatAvailableToolsSection(
  toolNames: string,
  instruction = AVAILABLE_TOOLS_SOURCE_INSTRUCTION,
): string {
  return `${AVAILABLE_TOOLS_SECTION_HEADING}\n\n${toolNames}\n\n${instruction}`;
}

export function replacePromptSection(
  prompt: string,
  heading: string,
  replacement: string,
): { prompt: string; replaced: boolean } {
  const start = prompt.indexOf(heading);
  if (start < 0) return { prompt, replaced: false };

  const end = prompt.indexOf(PROMPT_SECTION_SEPARATOR, start);
  return {
    prompt: `${prompt.slice(0, start)}${replacement}${end < 0 ? '' : prompt.slice(end)}`,
    replaced: true,
  };
}

export function removePromptSection(prompt: string, heading: string): string {
  const start = prompt.indexOf(heading);
  if (start < 0) return prompt;

  const separatorStart = start >= PROMPT_SECTION_SEPARATOR.length
    && prompt.slice(start - PROMPT_SECTION_SEPARATOR.length, start) === PROMPT_SECTION_SEPARATOR
    ? start - PROMPT_SECTION_SEPARATOR.length
    : start;
  const end = prompt.indexOf(PROMPT_SECTION_SEPARATOR, start);
  return end < 0
    ? prompt.slice(0, separatorStart).trimEnd()
    : `${prompt.slice(0, separatorStart)}${prompt.slice(end)}`;
}
