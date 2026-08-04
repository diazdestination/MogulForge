// Client-side helper for the scan form's bot trap: measures the time between
// form mount and submit. Kept out of the component so render code stays pure
// (no Date.now() or ref reads during render).
export type SubmitTimer = { start: () => void; elapsedMs: () => number };

export function createSubmitTimer(): SubmitTimer {
  let startedAt = 0;
  return {
    start: () => { startedAt = Date.now(); },
    elapsedMs: () => (startedAt ? Date.now() - startedAt : 0),
  };
}
