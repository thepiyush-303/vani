// ============================================================
// ttsUtils.ts — Text sanitization before Piper TTS pipeline
// PRD_v2.md §B.5: strips URLs, markdown links, citation refs,
// and HTML so the spoken output stays clean when Gemini
// Search Grounding is active.
// ============================================================

/**
 * Strips content that must never be spoken aloud:
 *  - Bare URLs (https://... or http://...)
 *  - Markdown hyperlinks → keeps display text only
 *  - Numeric citation brackets [1], [1,2], [1, 3]
 *  - HTML tags
 *  - Collapses runs of whitespace left by removals
 */
export function sanitizeForTTS(text: string): string {
  return text
    // 1. Markdown links: [display text](url) → "display text"
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // 2. Bare URLs (http/https)
    .replace(/https?:\/\/[^\s)>"]+/g, '')
    // 3. Citation / reference brackets: [1], [2,3], [1, 2, 3]
    .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
    // 4. HTML tags
    .replace(/<[^>]*>/g, '')
    // 5. Collapse multiple spaces / leading-trailing whitespace
    .replace(/\s{2,}/g, ' ')
    .trim();
}
