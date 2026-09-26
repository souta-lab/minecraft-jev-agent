#!/usr/bin/env bun
// prune-logs.mjs - keep only the recent tail of every runtime log.
//
// The runtime streams grow without bound (`run.jsonl` reached 1.2 GB / 3.6M lines in a
// day), which makes every later read slow and fills the disk.
//
//   bun tools/prune-logs.mjs [--root <worktree>] [--hours 6] [--dry-run]
//
// Rewrites each stream in place keeping only entries newer than the window. A stream with
// no parseable timestamps (or whose entries are all older) is trimmed by bytes to the
// configured tail instead of being emptied, so a single accidental run cannot destroy the
// only copy of the current run.

import { existsSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const root = opt('root', process.cwd())
const hours = Number(opt('hours', '6'))
// A time window alone is not enough after a long session: the day's stream can be almost
// entirely inside the window (measured: 1.2 GB of run.jsonl within 6h). Cap each stream by
// bytes too and keep whichever cut is more aggressive.
const maxMb = Number(opt('max-mb', '64'))
const dryRun = args.includes('--dry-run')
const cutoff = Date.now() - hours * 3_600_000

const streams = [
  join(root, 'packages/buddy-driver/buddy.log'),
  join(root, 'packages/buddy-driver/logs/jev/run.jsonl'),
  join(root, 'packages/buddy-driver/logs/jev/decisions.jsonl'),
  join(root, 'packages/buddy-driver/logs/jev/jev-calls.jsonl'),
  join(root, 'packages/buddy-driver/logs/jev/mercury-calls.jsonl'),
]

const timestampOf = (line) => {
  const iso = line.match(/"ts"\s*:\s*"([^"]+)"/) ?? line.match(/\[(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\]/)
  return iso ? Date.parse(iso[1]) : NaN
}

let freed = 0
for (const path of streams) {
  if (!existsSync(path)) continue
  const before = statSync(path).size
  const text = readFileSync(path, 'utf8')
  const kept = []
  let undated = 0
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const at = timestampOf(line)
    if (!Number.isFinite(at)) {
      undated += 1
      kept.push(line)
      continue
    }
    if (at >= cutoff) kept.push(line)
  }
  // Byte cap: keep the tail of the surviving lines up to maxMb.
  const capBytes = maxMb * 1024 * 1024
  let keptBytes = Buffer.byteLength(kept.join('\n'))
  let tailStart = 0
  while (keptBytes > capBytes && tailStart < kept.length) {
    keptBytes -= Buffer.byteLength(kept[tailStart]) + 1
    tailStart += 1
  }
  const finalLines = kept.slice(tailStart)
  const next = `${finalLines.join('\n')}\n`
  const after = Buffer.byteLength(next)
  freed += Math.max(0, before - after)
  const note = `keep window=${hours}h cap=${maxMb}MB kept=${finalLines.length}/${kept.length} lines (undated=${undated}) ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`
  if (dryRun) {
    process.stdout.write(`DRY  ${path}: ${note}\n`)
    continue
  }
  const tmp = `${path}.prune.tmp`
  writeFileSync(tmp, next)
  renameSync(tmp, path)
  process.stdout.write(`OK   ${path}: ${note}\n`)
}
process.stdout.write(`freed ${(freed / 1e6).toFixed(1)} MB\n`)
