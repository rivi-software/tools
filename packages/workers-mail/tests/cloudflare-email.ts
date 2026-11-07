/**
 * The Workers runtime's mail module for the tests (`vitest.config.ts`): an `EmailMessage` that keeps its raw
 * message readable, which the runtime's does not, so a test can see what the binding was handed.
 */
export class EmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: string;

  constructor(from: string, to: string, raw: string) {
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}
