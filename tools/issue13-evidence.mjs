// Pure log evidence helpers for issue #13.
// A callback carrying a disposed generation id is a direct stale-generation
// observation; an absent generation tag is an observability gap, not a pass.

function eventName(line) {
  return line.match(/^\[[^\]]+\]\s+(\S+)/)?.[1] ?? null
}

function field(line, name) {
  return line.match(new RegExp(`(?:^|\\s)${name}=([^\\s]+)`))?.[1] ?? null
}

export function inspectGenerationCallbackLog(text, { runId = null } = {}) {
  const lines = String(text ?? '').split(/\r?\n/)
  // buddy.log is append-only across host restarts. An explicit runId is the
  // authoritative scope; stop at the next BOOT for a different run so a
  // restart cannot combine listener evidence from two resident lifetimes.
  let scopeStart = 0
  let scopeEnd = lines.length
  let scopeMatched = true
  let scopeSource = 'provided-text'
  if (runId !== null) {
    scopeMatched = false
    scopeEnd = 0
    scopeSource = 'run-id-not-found'
    for (let index = 0; index < lines.length; index += 1) {
      if (eventName(lines[index]) !== 'BOOT' || field(lines[index], 'runId') !== runId) continue
      scopeStart = index
      scopeEnd = lines.length
      scopeMatched = true
      scopeSource = 'run-id'
      for (let end = index + 1; end < lines.length; end += 1) {
        if (eventName(lines[end]) === 'BOOT' && field(lines[end], 'runId') !== runId) {
          scopeEnd = end
          break
        }
      }
      break
    }
  } else {
    // Backward-compatible fixture mode: when no runId is supplied, use the
    // newest BOOT but label the result as non-authoritative run scoping.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (eventName(lines[index]) === 'BOOT') {
        scopeStart = index
        scopeSource = 'latest-boot-fallback'
        break
      }
    }
  }
  const disposed = new Set()
  const violations = []
  let actionLogs = 0
  let taggedActions = 0
  let pathCallbacks = 0
  let untaggedPathCallbacks = 0

  for (const [index, line] of lines.slice(scopeStart, scopeEnd).entries()) {
    const event = eventName(line)
    if (event === 'GENERATION_DISPOSED') {
      const id = field(line, 'id')
      if (id !== null) disposed.add(id)
      continue
    }
    if (event === 'ACTION') {
      actionLogs += 1
      if (field(line, 'generationId') !== null) taggedActions += 1
      continue
    }
    if (event !== 'PATH_CALLBACK') continue
    const generationId = field(line, 'generationId')
    if (generationId === null) {
      untaggedPathCallbacks += 1
      continue
    }
    pathCallbacks += 1
    if (disposed.has(generationId)) violations.push({ line: scopeStart + index + 1, generationId, lineText: line })
  }

  return {
    actionLogs,
    taggedActions,
    pathCallbacks,
    untaggedPathCallbacks,
    disposedGenerations: disposed.size,
    runId,
    scopeMatched,
    scopeSource,
    scopeStartLine: scopeMatched ? scopeStart + 1 : null,
    scopeEndLine: scopeMatched ? scopeEnd : null,
    staleCallbackViolations: violations,
    observabilityReady: scopeMatched && actionLogs > 0 && taggedActions === actionLogs && pathCallbacks > 0 && untaggedPathCallbacks === 0,
    noDisposedGenerationCallbacks: violations.length === 0,
  }
}
