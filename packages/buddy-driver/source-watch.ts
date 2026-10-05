// source-watch.ts - quiescence gate for the resident's hot-reload watcher.
//
// A signature delta can land mid-edit: the poll returns a trigger only after
// the signature has been stable for `quiesceCycles` consecutive polls, so a
// burst of saves cannot build a half-written tree.

export interface SourceWatchState {
  lastSignature: string
  pendingTrigger: string | null
  quietCycles: number
}

export function initialSourceWatchState(): SourceWatchState {
  return { lastSignature: '', pendingTrigger: null, quietCycles: 0 }
}

// One watcher poll. Returns the trigger to schedule, or null. The first
// observed signature is a baseline (never a trigger).
export function sourceWatchPoll(
  signature: string,
  state: SourceWatchState,
  quiesceCycles: number,
): string | null {
  if (signature !== state.lastSignature) {
    const first = state.lastSignature === ''
    state.lastSignature = signature
    if (first) return null
    state.pendingTrigger = 'source-changed'
    state.quietCycles = 0
    return null
  }
  if (state.pendingTrigger === null) return null
  state.quietCycles += 1
  if (state.quietCycles < quiesceCycles) return null
  const trigger = state.pendingTrigger
  state.pendingTrigger = null
  state.quietCycles = 0
  return trigger
}
