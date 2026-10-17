/**
 * The condensing prompt, and the language it asks for.
 *
 * The summary is read by a TTS voice, so anything a voice reads badly —
 * paths, hashes, version strings, long numbers, symbols — has to be kept out
 * here, before it exists. The text filter only catches markdown leftovers.
 */

/** Stands in for the language name inside a prompt. */
export const LANGUAGE_PLACEHOLDER = "{language}";

export const DEFAULT_SUMMARY_PROMPT = [
  "Summarize the assistant message below for text-to-speech.",
  "",
  "Rules:",
  `- Write the summary in ${LANGUAGE_PLACEHOLDER}, whatever language the message is in.`,
  "- Two or three short sentences, no more.",
  "- Plain spoken prose: no markdown, no lists, no code, no headings.",
  "- Say what was done or found and what it means.",
  "- Never read out file paths, file names, URLs, commands, flags, function or variable names, commit hashes, IDs, version numbers or line numbers. Describe them in words instead, for example \"the settings file\" or \"the new version\".",
  "- A ticket key alone is fine, without path or link, for example BBP-22.",
  "- Avoid numbers. Use a small count only if it is the point, written as a word.",
  "- No special characters: no slashes, underscores, backticks, brackets, arrows, hash signs, at signs or emoji.",
  "- Answer with the summary alone, nothing else.",
  "",
  "Message:",
].join("\n");

/**
 * The English name of a BCP-47 tag, for a prompt to name: `de` → German,
 * `en-GB` → British English. Unknown tags pass through unchanged.
 */
export function languageName(tag: string): string {
  const trimmed = tag.trim();
  if (trimmed === "") return "English";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(trimmed) ?? trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Fill the language into a prompt. A custom prompt without the placeholder
 * still gets the language as a first line — not a last one, because the
 * answer is appended right after the prompt.
 */
export function buildSummaryPrompt(template: string, language: string): string {
  const prompt = template.trim() === "" ? DEFAULT_SUMMARY_PROMPT : template;
  const name = languageName(language);
  if (prompt.includes(LANGUAGE_PLACEHOLDER)) {
    return prompt.split(LANGUAGE_PLACEHOLDER).join(name);
  }
  return `Write the summary in ${name}.\n\n${prompt}`;
}
