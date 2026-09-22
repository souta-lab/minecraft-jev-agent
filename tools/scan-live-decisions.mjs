// Read-only live evidence scan (task/portal-descent). Scans the tail of the
// resident's run.jsonl and reports, per tick, the offered candidate ids, the
// withheld ENTER candidates, and any move-target blacklist skips.
// Usage: bun tools/scan-live-decisions.mjs <run.jsonl> [maxLines] [lastSeconds]
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const path = process.argv[2]
const maxLines = Number(process.argv[3] ?? 400_000)
const lastSeconds = Number(process.argv[4] ?? 900)

const lines = []
const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
for await (const line of rl) {
  lines.push(line)
  if (lines.length > maxLines) lines.shift()
}

const records = []
for (const line of lines) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  if (typeof record.ts !== 'string') continue
  records.push(record)
}
if (records.length === 0) {
  console.log('no records')
  process.exit(0)
}
const lastTs = Date.parse(records[records.length - 1].ts)
const cutoff = lastTs - lastSeconds * 1000
const inWindow = records.filter((record) => Date.parse(record.ts) >= cutoff)

const byTick = new Map()
const info = (key) => {
  let entry = byTick.get(key)
  if (entry === undefined) {
    entry = { key, ts: '', offered: [], withheld: [], enter: [], skipped: [], starvation: [], decision: null }
    byTick.set(key, entry)
  }
  return entry
}

let generation = null
for (const record of inWindow) {
  const message = typeof record.message === 'string' ? record.message : ''
  const detail = record.detail ?? {}
  if (message.startsWith('GENERATION_READY')) generation = detail.id ?? message
  const key = `${generation ?? 'gen?'}#${record.tick ?? 'null'}`
  const entry = info(key)
  entry.ts = record.ts
  if (record.source === 'candidates' && message.startsWith('generated')) {
    entry.offered = Array.isArray(detail.ids) ? detail.ids : []
  }
  if (message.startsWith('CANDIDATE_WITHHELD')) {
    const id = message.match(/candidate=(\S+)/)?.[1]
    if (id !== undefined) entry.withheld.push(`${id}:${message.match(/reason=(\S+)/)?.[1] ?? '?'}`)
  }
  if (message.startsWith('REACHABILITY') && message.includes('ENTER')) {
    entry.enter.push(message.replace(/^REACHABILITY\s+/, ''))
  }
  if (message.includes('MOVE_TARGET_SKIPPED')) entry.skipped.push(message)
  if (message.startsWith('CANDIDATE_STARVATION')) entry.starvation.push(message)
  if (record.source === 'policy' && message.startsWith('JEV_HEADS')) entry.decision = message
}

const keys = [...byTick.keys()].slice(-30)
for (const key of keys) {
  const entry = byTick.get(key)
  if (entry === undefined) continue
  if (entry.offered.length === 0 && entry.enter.length === 0 && entry.withheld.length === 0) continue
  console.log(`--- ${key}  ${entry.ts}`)
  console.log(`  offered(${entry.offered.length}): ${entry.offered.join(', ') || 'none'}`)
  if (entry.withheld.length > 0) console.log(`  withheld: ${entry.withheld.join(' | ')}`)
  for (const line of entry.enter.slice(-2)) console.log(`  ${line}`)
  for (const line of entry.skipped) console.log(`  ${line}`)
  for (const line of entry.starvation) console.log(`  ${line}`)
  if (entry.decision !== null) console.log(`  ${entry.decision}`)
}
