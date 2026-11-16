// The one line `operator-inbox: …` prints for an error, before it exits
// non-zero, with no stack trace. `index.ts` holds the boundary that calls this.
const describeMessage = (e: unknown): string =>
  e instanceof Error
    ? e.message
    : typeof e === 'object' && e !== null && 'message' in e
      ? String((e as { readonly message: unknown }).message)
      : String(e);

const tagOf = (e: unknown): unknown =>
  typeof e === 'object' && e !== null
    ? (e as { readonly _tag?: unknown })._tag
    : undefined;

// A tagged error with no message of its own (a bare `ServeError`, say) would
// print `operator-inbox: ` and nothing else, so it prints its tag instead.
export const describeError = (e: unknown): string => {
  const message = describeMessage(e);
  const tag = tagOf(e);
  return message === '' && typeof tag === 'string' ? tag : message;
};
