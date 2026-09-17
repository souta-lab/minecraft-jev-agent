#!/usr/bin/env node
// apply-movement-patch.mjs
//
// Re-applies the local movement patches after `npm install`. Two dependency
// defects make a Leaf 1.21.11 server reject the bot's movement while it is in
// contact with terrain (see ~/mc-ai/ARCHITECTURE.md section 9 and the read-only
// harness ~/mc-ai/mcbot/movement-test/README.md sections 7-9):
//
//   patches/mineflayer-4.39.0-locomotion.patch
//     1. `sendPacketPositionAndLook()` (the clientbound-teleport reply) writes the
//        server's target position into `lastSent`, so the very next tick compares
//        against the wrong origin and re-sends a server-rejected packet forever.
//     2. `updatePosition()` re-sends for any exact inequality, including
//        sub-threshold jitter; vanilla sends at >2e-4 blocks (squared 4e-8) or
//        after 20 ticks.
//
//   patches/mineflayer-pathfinder-2.4.5-jump.patch
//     3. The stock pathfinder holds `forward` while it sets `jump` (sprint-jump /
//        walk-jump branches), so the packet sent into a step is
//        jump + blocked-forward, which the server rejects. When already pinned,
//        release forward for a pure vertical hop and resume forward airborne.
//
// The two mineflayer hunks are a strict subset of the open upstream PR #4063.
// All patches are reversible: delete the dependency dirs and reinstall with
// `npm ci --ignore-scripts`.
//
// Usage:  node scripts/apply-movement-patch.mjs [--check]
// Exit 0 when every patch is applied or already present; non-zero on any failure
// so `npm install` surfaces a broken patch immediately.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PATCH_DIR = join(root, 'patches')
const MARKER = '[jev-agent patch]'

/** Parse unified diffs into [{ target, hunks: [{ oldText, newText }] }]. */
function parsePatch(text) {
  const files = []
  let current = null
  let hunk = null
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  for (const line of body.split('\n')) {
    if (line.startsWith('--- ')) {
      current = { target: null, hunks: [] }
      continue
    }
    if (line.startsWith('+++ ')) {
      if (current !== null) {
        current.target = line.slice(4).trim().replace(/^[ab]\//, '')
        files.push(current)
      }
      hunk = null
      continue
    }
    if (line.startsWith('@@')) {
      hunk = []
      current?.hunks.push(hunk)
      continue
    }
    if (hunk === null) continue
    if (line === '') {
      hunk.push(' ') // blank context line
      continue
    }
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    const prefix = line[0]
    if (prefix !== ' ' && prefix !== '+' && prefix !== '-') continue
    hunk.push(line)
  }
  for (const file of files) {
    file.hunks = file.hunks.map((lines) => ({
      oldText: lines.filter((l) => l[0] !== '+').map((l) => l.slice(1)).join('\n') + '\n',
      newText: lines.filter((l) => l[0] !== '-').map((l) => l.slice(1)).join('\n') + '\n',
    }))
  }
  return files.filter((file) => file.target !== null && file.hunks.length > 0)
}

/** Per-target post-apply verification: both fixes must be present. */
const VERIFIERS = {
  'node_modules/mineflayer/lib/plugins/physics.js': (text) => [
    ['teleport reply helper', text.includes('function sendTeleportReply (')],
    ['teleport call site', text.includes('sendTeleportReply(pos, newYaw, newPitch)')],
    ['vanilla position threshold', text.includes('dx * dx + dy * dy + dz * dz > 4e-8 || positionReminder >= 20')],
    ['reminder reset', text.includes('if (positionUpdated) positionReminder = 0')],
  ],
  'node_modules/mineflayer-pathfinder/index.js': (text) => [
    ['pinned detection', text.includes('const pinnedAgainstStep = bot.entity.isCollidedHorizontally === true')],
    ['sprint-jump forward release', text.includes("if (pinnedAgainstStep) bot.setControlState('forward', false)\n      bot.setControlState('jump', true)\n      bot.setControlState('sprint', !pinnedAgainstStep)")],
    ['walk-jump forward release', text.includes("if (pinnedAgainstStep) bot.setControlState('forward', false)\n      bot.setControlState('jump', true)\n      bot.setControlState('sprint', false)")],
  ],
}

function applyFile(checkOnly, file) {
  const target = join(root, file.target)
  if (!existsSync(target)) {
    console.log(`[movement-patch] skip: ${file.target} does not exist`)
    return { applied: 0, already: 0, checks: [] }
  }
  let content = readFileSync(target, 'utf8')
  let applied = 0
  let already = 0
  for (const hunk of file.hunks) {
    const at = content.indexOf(hunk.oldText)
    if (at !== -1) {
      if (checkOnly) throw new Error(`patch is NOT applied (hunk found intact in ${file.target})`)
      content = content.slice(0, at) + hunk.newText + content.slice(at + hunk.oldText.length)
      applied += 1
      continue
    }
    if (content.includes(hunk.newText)) {
      already += 1
      continue
    }
    throw new Error(
      `hunk does not match ${file.target} (dependency changed?). ` +
        'The patches target mineflayer@4.39.0 / mineflayer-pathfinder@2.4.5; update patches/ if bumped.',
    )
  }
  if (!checkOnly && applied > 0) writeFileSync(target, content)

  const verify = VERIFIERS[file.target]
  const checks = verify === undefined ? [] : verify(readFileSync(target, 'utf8'))
  const failed = checks.filter(([, ok]) => !ok)
  if (failed.length > 0) {
    throw new Error(`verification failed for ${file.target}: ${failed.map(([name]) => name).join(', ')}`)
  }
  if (checks.length > 0) {
    console.log(
      `[movement-patch] ${file.target}: applied ${applied} hunk(s), ${already} already present; verified ${checks.length}/${checks.length} checks`,
    )
  } else {
    console.log(`[movement-patch] ${file.target}: applied ${applied} hunk(s), ${already} already present`)
  }
  return { applied, already, checks }
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const patchFiles = readdirSync(PATCH_DIR)
    .filter((name) => name.endsWith('.patch'))
    .sort()
  if (patchFiles.length === 0) throw new Error(`no .patch files in ${PATCH_DIR}`)

  let totalApplied = 0
  let totalAlready = 0
  for (const name of patchFiles) {
    const files = parsePatch(readFileSync(join(PATCH_DIR, name), 'utf8'))
    if (files.length === 0) throw new Error(`no target hunks parsed from ${name}`)
    for (const file of files) {
      const result = applyFile(checkOnly, file)
      totalApplied += result.applied
      totalAlready += result.already
    }
  }
  if (checkOnly) {
    console.log(`[movement-patch] ok: all patched target(s) already applied (${patchFiles.length} patch file(s))`)
    return
  }
  console.log(`[movement-patch] done: applied ${totalApplied} hunk(s), ${totalAlready} already present`)
  void MARKER
}

try {
  main()
} catch (error) {
  console.error(`[movement-patch] ERROR: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
