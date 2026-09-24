export function parseConsoleRelayJournal(text) {
  const rows = []
  try {
    for (const line of String(text).split(/\r?\n/).filter(Boolean)) rows.push(JSON.parse(line))
  } catch {
    return { rows: [], error: 'console relay journal contains invalid JSON' }
  }
  return { rows, error: null }
}

export function validateConsoleRelayJournal(text, { leafPid, expectedCommands, totalExpectedCommandCount = expectedCommands.length }) {
  const parsed = parseConsoleRelayJournal(text)
  if (parsed.error !== null) return { valid: false, reason: parsed.error, rows: parsed.rows, forwarded: [] }
  const [start, ...rest] = parsed.rows
  if (
    !Number.isInteger(totalExpectedCommandCount) || totalExpectedCommandCount < expectedCommands.length ||
    start?.event !== 'console-relay-start' || start.leafPid !== leafPid || start.expectedCommandCount !== totalExpectedCommandCount
  ) {
    return { valid: false, reason: 'console relay start record is missing or not bound to Leaf PID/query plan', rows: parsed.rows, forwarded: [] }
  }
  if (rest.some((row) => row?.leafPid !== leafPid || !['console-relay-input', 'console-relay-forwarded', 'console-relay-buffer-state'].includes(row?.event) || (row?.event === 'console-relay-buffer-state' && row.byteLength !== 0))) {
    return { valid: false, reason: 'console relay records a rejected, partial, failed, exited, or unrecognized console input', rows: parsed.rows, forwarded: [] }
  }
  const forwarded = rest.filter((row) => row.event === 'console-relay-forwarded')
  if (forwarded.length !== expectedCommands.length || forwarded.some((row, index) => row.sequence !== index || row.command !== expectedCommands[index])) {
    return { valid: false, reason: 'console relay did not forward exactly the descriptor read-only query sequence', rows: parsed.rows, forwarded }
  }
  return { valid: true, reason: null, rows: parsed.rows, forwarded }
}
