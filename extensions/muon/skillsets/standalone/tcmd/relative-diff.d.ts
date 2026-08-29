export type RelativeDelta = {
  text: string;
  aligned: boolean;
};

export function relativeDelta(previous: string, current: string): RelativeDelta;
