#!/usr/bin/env node
// m2-watch: read-only scan of the buddy-driver log for M2 milestone markers.
// Usage: node tools/m2-watch.mjs [--log <path>]
// Default log: /home/s0u7a/mc-ai/buddy-driver/buddy.log
// Exit: 0 = required M2 set complete, 1 = incomplete, 2 = log unreadable.
// Prints UNKNOWN and never fabricates data when the log cannot be read.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'

const DEFAULT_LOG = '/home/s0u7a/mc-ai/buddy-driver/buddy.log'

const MARKERS = [
  'PREREQ_OPTION',
  'PREREQ_SWITCH',
  'ABANDON_ENFORCED',
  'ABANDON_SUPPRESSED',
  'ACTION_UNVERIFIED',
  'MOVE_TARGET_SKIPPED',
  'OSCILLATION_DETECTED',
  'FURNACE_READY',
  'SMELT_DONE',
  'RUNG_MISMATCH',
  'RELOAD_REJECTED',
]
const REQUIRED = ['PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE']

function parseArgs(argv) {
  const idx = argv.indexOf('--log')
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1]
  return process.env.BUDDY_LOG || DEFAULT_LOG
}

const TS_RE = /^\[([^\]]+)\]/

function extractTimestamp(line) {
  const m = TS_RE.exec(line)
  return m ? m[1] : null
}

async function scan(logPath) {
  const stats = { counts: new Map(), first: new Map(), last: new Map(), heartbeat: null }
  for (const m of MARKERS) stats.counts.set(m, 0)

  const rl = createInterface({ input: createReadStream(logPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    for (const marker of MARKERS) {
      if (line.includes(marker)) {
        stats.counts.set(marker, stats.counts.get(marker) + 1)
        const ts = extractTimestamp(line)
        if (!stats.first.has(marker)) stats.first.set(marker, ts)
        stats.last.set(marker, ts)
      }
    }
    if (line.includes('HEARTBEAT')) stats.heartbeat = line
  }
  return stats
}

const logPath = parseArgs(process.argv.slice(2))

if (!existsSync(logPath)) {
  console.log('UNKNOWN')
  console.error(`M2_WATCH log=${logPath} status=UNREADABLE reason=missing`)
  process.exit(2)
}
try {
  const st = statSync(logPath)
  if (!st.isFile()) throw new Error('not a file')
} catch (err) {
  console.log('UNKNOWN')
  console.error(`M2_WATCH log=${logPath} status=UNREADABLE reason=${err.message}`)
  process.exit(2)
}

let stats
try {
  stats = await scan(logPath)
} catch (err) {
  console.log('UNKNOWN')
  console.error(`M2_WATCH log=${logPath} status=UNREADABLE reason=${err.message}`)
  process.exit(2)
}

console.log(`M2_WATCH log=${logPath}`)
for (const marker of MARKERS) {
  const count = stats.counts.get(marker)
  if (count === 0) {
    console.log(`${marker} MISSING`)
  } else {
    console.log(`${marker} count=${count} first=${stats.first.get(marker) ?? 'null'} last=${stats.last.get(marker) ?? 'null'}`)
  }
}

if (stats.heartbeat) {
  console.log(`HEARTBEAT ${stats.heartbeat}`)
} else {
  console.log('HEARTBEAT MISSING')
}

const missingRequired = REQUIRED.filter((m) => stats.counts.get(m) === 0)
if (missingRequired.length > 0) {
  console.log(`M2_REQUIRED status=INCOMPLETE missing=${missingRequired.join(',')}`)
  process.exit(1)
}
console.log('M2_REQUIRED status=COMPLETE')
process.exit(0)
