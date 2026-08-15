export const MAX_PROSE_WORDS: number;
export const INTERNAL_REFERENCES: readonly RegExp[];
export const TEMPORAL_CLAIMS: readonly RegExp[];
export const SLOP: readonly RegExp[];
export const firstMatch: (patterns: readonly RegExp[], text: string) => string | undefined;
export const countWords: (prose: string) => number;
