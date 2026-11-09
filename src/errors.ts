export class GraphError extends Error {
  override readonly name = 'GraphError';
  constructor(message: string) {
    super(message);
  }
}
