export interface TokenSlice {
  readonly text: string;
  readonly tokenCount?: number;
}

export interface TokenizerPort {
  count(text: string): number;
  split(input: {
    readonly text: string;
    readonly maximumTokens: number;
  }): readonly TokenSlice[];
}

export interface ChineseSegmenterPort {
  segment(text: string): readonly string[];
}
