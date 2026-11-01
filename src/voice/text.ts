//! What Whisper heard, cleaned for typing into a pane.

/** Whole utterances Whisper invents from silence or noise. */
const hallucinations = new Set([
  "thank you",
  "thanks for watching",
  "thank you for watching",
  "you",
  "bye",
  "subtitles by the amara org community",
]);
const fillers = new Set(["um", "uh", "hmm", "ah", "er"]);

/** The text to type, or null when nothing worth typing is left. */
export function clean(raw: string): string | null {
  const text = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, " ")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/\x1b[ -/]*[0-~]?/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Sounds Whisper describes, as *clap* or [music], alone or beside speech.
  const spoken = text
    .replace(/\*+\S(?:[^*]*\S)?\*+|\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^\(.*\)$/s.test(spoken) || /[♪♫]/.test(spoken)) return null;
  if (hallucinations.has(normalized(spoken))) return null;
  const words: string[] = [];
  for (const word of spoken.split(" ")) {
    const parts = /^(\p{L}+)([,.!?;:]*)$/u.exec(word);
    if (parts && fillers.has(parts[1].toLowerCase())) {
      // "add tests, um." keeps its full stop.
      const end = parts[2].replace(/[,;:]/g, "");
      if (end && words.length) words[words.length - 1] = words[words.length - 1].replace(/[,;:]+$/, "") + end;
      continue;
    }
    words.push(word);
  }
  const kept = words.join(" ").trim();
  if (hallucinations.has(normalized(kept))) return null;
  return /[\p{L}\p{N}]/u.test(kept) ? kept : null;
}
/** Lowercase words without punctuation, for whole-utterance comparisons. */
export function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
