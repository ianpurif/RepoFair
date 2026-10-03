export class AtlasError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AtlasError';
    this.code = code;
  }
}
export function requireCondition(value: boolean, code: string, message: string): asserts value {
  if (!value) throw new AtlasError(code, message);
}
