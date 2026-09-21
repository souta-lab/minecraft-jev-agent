#!/usr/bin/env bun
// consolidated-log.mjs - one chronological view of every event stream.
//
// The runtime writes several streams (the human `buddy.log`, the structured
// `logs/jev/*.jsonl`, the server log, the supervisor log). Debugging a stall means
// reading them side by side and guessing the interleaving. This tool merges the
// recent tail of each stream into ONE timestamp-sorted view so a single file answers
// "what happened, in order".
//
//   bun tools/consolidated-log.mjs --root /path/to/worktree [--minutes 15] [--tail 400000] [--out /path/file] [--follow]
//
// Every line keeps its origin: `HH:MM:SS.mmm [stream] <marker> k=v ...`.

import { existsSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const root = opt('root', process.cwd())
const minutes = Number(opt('minutes', '15'))
const tailLines = Number(opt('tail', '400000'))
const follow = flag('follow')
const out = opt('out', null)

const streams = [
  { name: 'agent', path: join(root, 'buddy-driver/buddy.log'), kind: 'text' },
  { name: 'run', path: join(root, 'buddy-driver/logs/jev/run.jsonl'), kind: 'jsonl' },
  { name: 'decision', path: join(root, 'buddy-driver/logs/jev/decisions.jsonl'), kind: 'jsonl' },
  { name: 'jev', path: join(root, 'buddy-driver/logs/jev/jev-calls.jsonl'), kind: 'jsonl' },
  { name: 'mercury', path: join(root, 'buddy-driver/logs/jev/mercury-calls.jsonl'), kind: 'jsonl' },
  { name: 'server', path: '/home/s0u7a/mc-server/server.log', kind: 'server' },
]

const cutoff = Date.now() - minutes * 60_000

function tailLinesOf(path, maxLines) {
  const size = statSync(path).size
  const chunk = 8 * 1024 * 1024
  let start = Math.max(0, size - chunk)
  let buf = ''
  for (let guard = 0; guard < 40 && start > 0; guard += 1) {
    const read = readFileSync(path)
    buf = read.toString('utf8')
    // If we read the whole file or have enough newlines, stop.
    const newlines = (buf.match(/\n/g) ?? []).length
    if (start === 0 || newlines >= maxLines) break
    start = Math.max(0, start - chunk)
    // read the prefix we are missing
    const fd = readFileSync(path)
    buf = fd.toString('utf8')
    break
  }
  const lines = buf.split('\n')
  return lines.slice(Math.max(0, lines.length - maxLines))
}

function timestampOf(line, kind) {
  if (kind === 'jsonl') {
    const match = line.match(/"ts"\s*:\s*"([^"]+)"/)
    if (match) return Date.parse(match[1])
    return NaN
  }
  const iso = line.match(/\[(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\]/)
  if (iso) return Date.parse(iso[1])
  const clock = line.match(/\[(\d{2}:\d{2}:\d{2})\]/)
  if (clock) {
    const today = new Date().toISOString().slice(0, 10)
    return Date.parse(`${today}T${clock[1]}Z`)
  }
  return NaN
}

function project(line, kind, name) {
  if (kind === 'jsonl') {
    try {
      const record = JSON.parse(line)
      const keys = [
        'marker', 'record', 'event', 'kind', 'reason', 'status', 'actionId', 'candidateId',
        'goal', 'rung', 'strategy', 'op', 'trigger', 'model', 'provider', 'error', 'outcome',
        'key', 'attempts', 'efficiency', 'beta', 'from', 'to', 'pos', 'queue', 'inventory',
      ]
      const parts = []
      for (const key of keys) {
        const value = record[key]
        if (value === undefined || value === null) continue
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
        parts.push(`${key}=${text.length > 90 ? `${text.slice(0, 90)}…` : text}`)
      }
      const head = record.marker ?? record.record ?? record.event ?? 'record'
      return `${head} ${parts.join(' ')}`
    } catch {
      return line.slice(0, 200)
    }
  }
  return line
    .replace(/^\s*>\s*/, '')
    .replace(/^\[\d{4}-\d{2}-\d{2}T[0-9:.]+Z\]\s*/, '')
    .slice(0, 220)
}

const merged = []
for (const stream of streams) {
  if (!existsSync(stream.path)) continue
  for (const raw of tailLinesOf(stream.path, tailLines)) {
    const line = raw.trimEnd()
    if (line.length === 0) continue
    const at = timestampOf(line, stream.kind)
    if (!Number.isFinite(at) || at < cutoff) continue
    merged.push({ at, name: stream.name, text: project(line, stream.kind, stream.name) })
  }
}

merged.sort((a, b) => a.at - b.at)

const render = (entry) => `${new Date(entry.at).toISOString()} [${entry.name}] ${entry.text}`
const header = [
  `# consolidated log  streams=${streams.filter((s) => existsSync(s.path)).map((s) => s.name).join(',')}`,
  `# window=last ${minutes}m  events=${merged.length}  generated=${new Date().toISOString()}`,
].join('\n')

if (out !== null) {
  writeFileSync(out, `${header}\n${merged.map(render).join('\n')}\n`)
  process.stdout.write(`${out}: ${merged.length} events over the last ${minutes}m\n`)
} else {
  process.stdout.write(`${header}\n`)
  for (const entry of merged) process.stdout.write(`${render(entry)}\n`)
}
