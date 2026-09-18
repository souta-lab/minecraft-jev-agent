// Pure log evidence helpers for issue #13.
// A callback carrying a disposed generation id is a direct stale-generation
// observation; an absent generation tag is an observability gap, not a pass.

function eventName(line) {
  return line.match(/^\[[^\]]+\]\s+(\S+)/)?.[1] ?? null
}

function field(line, name) {
  return line.match(new RegExp(`(?:^|\\s)${name}=([^\\s]+)`))?.[1] ?? null
}

export function inspectGenerationCallbackLog(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  // buddy.log is append-only across host restarts. A host restart is required
  // for the ACTION tag, so scope evidence to the newest BOOT boundary and do
  // not let historical untagged records make the current run fail forever.
  let scopeStart = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (eventName(lines[index]) === 'BOOT') {
      scopeStart = index
      break
    }
  }
  const disposed = new Set()
  const violations = []
  let actionLogs = 0
  let taggedActions = 0
  let pathCallbacks = 0
  let untaggedPathCallbacks = 0

  for (const [index, line] of lines.slice(scopeStart).entries()) {
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
    scopeStartLine: scopeStart + 1,
    staleCallbackViolations: violations,
    observabilityReady: actionLogs > 0 && taggedActions === actionLogs && pathCallbacks > 0 && untaggedPathCallbacks === 0,
    noDisposedGenerationCallbacks: violations.length === 0,
  }
}
