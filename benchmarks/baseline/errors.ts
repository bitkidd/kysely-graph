export class LoaderError extends Error {
  override readonly name = 'LoaderError';
  constructor(message: string) { super(message); }
}
