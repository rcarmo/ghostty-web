/**
 * Local type declarations for bidi-js 1.0.3 (lojjic/bidi-js), which ships
 * no TypeScript types. API per its README; indices are UTF-16 code-unit
 * positions into the input string.
 */
declare module 'bidi-js' {
  export interface EmbeddingLevelsResult {
    /** Embedding level per code unit; odd = RTL scope. */
    levels: Uint8Array;
    paragraphs: { start: number; end: number; level: number }[];
  }
  export interface BidiApi {
    getEmbeddingLevels(text: string, explicitDirection?: 'ltr' | 'rtl'): EmbeddingLevelsResult;
    /** Returns indices in visual order: result[visualPos] = logical code-unit index. */
    getReorderedIndices(
      text: string,
      embeddingLevels: EmbeddingLevelsResult,
      start?: number,
      end?: number
    ): number[];
    getReorderSegments(
      text: string,
      embeddingLevels: EmbeddingLevelsResult,
      start?: number,
      end?: number
    ): [number, number][];
    getMirroredCharacter(char: string): string | null;
    /** Map of code-unit index → replacement character (UBA rule L4).
     * embeddingLevels is the raw Uint8Array from EmbeddingLevelsResult.levels. */
    getMirroredCharactersMap(
      text: string,
      embeddingLevels: Uint8Array,
      start?: number,
      end?: number
    ): Map<number, string>;
  }
  export default function bidiFactory(): BidiApi;
}
