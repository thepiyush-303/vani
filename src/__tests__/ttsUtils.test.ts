// ============================================================
// ttsUtils.test.ts — Unit tests for sanitizeForTTS
// ============================================================

import { sanitizeForTTS } from '../ttsUtils';

describe('sanitizeForTTS', () => {
  // ── Bare URLs ──────────────────────────────────────────────

  it('strips bare https URLs', () => {
    expect(sanitizeForTTS('Visit https://example.com for more.')).toBe('Visit for more.');
  });

  it('strips bare http URLs', () => {
    expect(sanitizeForTTS('Source: http://news.site/article')).toBe('Source:');
  });

  it('strips URLs with paths and query strings', () => {
    expect(sanitizeForTTS('See https://google.com/search?q=weather&hl=en here.')).toBe('See here.');
  });

  // ── Markdown links ─────────────────────────────────────────

  it('converts markdown links to display text only', () => {
    expect(sanitizeForTTS('[Google](https://google.com)')).toBe('Google');
  });

  it('handles multiple markdown links in one string', () => {
    const input = '[first](https://a.com) and [second](https://b.com)';
    expect(sanitizeForTTS(input)).toBe('first and second');
  });

  // ── Citation brackets ──────────────────────────────────────

  it('strips single citation brackets [1]', () => {
    expect(sanitizeForTTS('The sky is blue.[1]')).toBe('The sky is blue.');
  });

  it('strips multi-citation brackets [1,2]', () => {
    expect(sanitizeForTTS('Water boils at 100°C.[1,2]')).toBe('Water boils at 100°C.');
  });

  it('strips spaced multi-citation brackets [1, 3]', () => {
    expect(sanitizeForTTS('This is true.[1, 3, 5]')).toBe('This is true.');
  });

  // ── HTML tags ──────────────────────────────────────────────

  it('strips HTML tags', () => {
    expect(sanitizeForTTS('<b>Bold text</b> and <em>emphasis</em>')).toBe('Bold text and emphasis');
  });

  it('strips HTML links', () => {
    expect(sanitizeForTTS('<a href="https://x.com">Link</a>')).toBe('Link');
  });

  // ── Whitespace collapsing ──────────────────────────────────

  it('collapses multiple spaces after stripping', () => {
    // After stripping "https://example.com " there will be double space
    const result = sanitizeForTTS('Click here https://example.com to learn more.');
    expect(result).not.toContain('  ');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeForTTS('  hello  ')).toBe('hello');
  });

  // ── Edge cases ─────────────────────────────────────────────

  it('returns empty string for empty input', () => {
    expect(sanitizeForTTS('')).toBe('');
  });

  it('leaves clean text unchanged', () => {
    const clean = 'The weather in Paris today is partly cloudy with a high of 22 degrees.';
    expect(sanitizeForTTS(clean)).toBe(clean);
  });

  it('handles text that is only a URL', () => {
    expect(sanitizeForTTS('https://only-a-url.com')).toBe('');
  });

  it('preserves natural sentence with a number in brackets not a citation', () => {
    // [abc] should not be affected — only numeric-only brackets
    expect(sanitizeForTTS('Press [Enter] to continue.')).toBe('Press [Enter] to continue.');
  });
});
