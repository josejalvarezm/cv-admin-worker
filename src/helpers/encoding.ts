/**
 * Encoding Helper Functions
 * 
 * Single Responsibility: Fix character encoding issues (mojibake)
 * from UTF-8 misinterpretation in responses
 */

/**
 * Fix encoding issues in strings (mojibake from UTF-8 misinterpretation)
 * Common issues: ÔÇô → – (en-dash), ÔÇæ → (zero-width/space)
 */
export function fixEncoding(text: string | null | undefined): string | null {
  if (!text) return text as null;
  return text
    .replace(/ÔÇô/g, '–')      // en-dash
    .replace(/ÔÇæ/g, '-')       // zero-width joiner → regular hyphen
    .replace(/ÔÇö/g, '—')       // em-dash
    .replace(/ÔÇÿ/g, "'")       // smart quote
    .replace(/ÔÇ£/g, '"')       // smart quote open
    .replace(/ÔÇØ/g, '"');      // smart quote close
}

/**
 * Recursively fix encoding issues in an object
 */
export function fixEncodingInObject<T>(obj: T): T {
  if (typeof obj === 'string') {
    return fixEncoding(obj) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => fixEncodingInObject(item)) as T;
  }
  if (obj && typeof obj === 'object') {
    const fixed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      fixed[key] = fixEncodingInObject(value);
    }
    return fixed as T;
  }
  return obj;
}
