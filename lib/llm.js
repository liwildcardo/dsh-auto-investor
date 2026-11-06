/**
 * LLM stream helper: the harness reports adapter/dispatch failures as a
 * terminal `finish` chunk with `reason.kind === 'error' | 'aborted'`, not as
 * a throw. Accumulate text deltas and surface failures explicitly.
 */
export async function collectStream(stream, { timeoutMs = 60_000 } = {}) {
  let text = '';
  const deadline = Date.now() + timeoutMs;
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta') {
      if (typeof chunk.text === 'string') text += chunk.text;
    } else if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind ?? chunk.reason;
      if (kind === 'error' || kind === 'aborted') {
        const msg = chunk.reason?.message ?? chunk.reason?.error?.message ?? kind;
        throw new Error(`LLM stream ${kind}: ${msg}`);
      }
    }
    if (Date.now() > deadline) throw new Error(`LLM stream timed out after ${timeoutMs}ms`);
  }
  return text;
}
