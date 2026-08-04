/**
 * Scriptable stand-in for lib/openai.ts (swapped in by openai-stub-loader).
 * Tests queue behaviors with `scriptResponse` / `scriptError`; every
 * `responses.create` call consumes the next queued behavior and is recorded
 * in `calls` so tests can assert whether (and how) the model was invoked.
 */
const queue = [];
export const calls = [];

/** Queue a raw `output_text` string the fake model will return next. */
export function scriptResponse(outputText) {
  queue.push({ outputText });
}

/** Queue a model failure (e.g. network/API error) for the next call. */
export function scriptError(message) {
  queue.push({ error: new Error(message) });
}

export function resetStub() {
  queue.length = 0;
  calls.length = 0;
}

export function getOpenAIClient() {
  return {
    responses: {
      create: async (params) => {
        calls.push(params);
        const next = queue.shift();
        if (!next) throw new Error("openai-stub: no scripted response queued");
        if (next.error) throw next.error;
        return { output_text: next.outputText };
      },
    },
  };
}
