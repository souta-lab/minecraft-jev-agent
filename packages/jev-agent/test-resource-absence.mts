// #406: `null` (unloaded) and `Block('air')` (loaded air) are different facts.
//
// Mineflayer 4.39 `bot.blockAt(point)` returns null only when the point is not
// loaded; a loaded cell returns a Block whose name may be `air`. Merging those two
// into "unknown" kept stale RETRIEVE routes alive for resources the world had
// already proven absent (measured: remembered obsidian the agent itself had mined
// away was still offered as a route).
import { probeKnownResources } from './src/state.ts'
import type { KnownResource } from './src/state.ts'

const CELL = { x: 12, y: 40, z: -7 }
const REMEMBERED: KnownResource[] = [{ name: 'obsidian', kind: 'ore', position: CELL }]

/** A bot double with exactly Mineflayer's documented contract. */
const botWith = (block: { name: string; boundingBox?: string } | null): never =>
  ({ blockAt: () => block }) as never

const statusFor = (block: { name: string; boundingBox?: string } | null): string =>
  probeKnownResources(botWith(block), 'obsidian', REMEMBERED)[0]?.status ?? 'missing'

const cases: Array<{ name: string; pass: boolean; detail: string }> = []
const addCase = (name: string, run: () => { pass: boolean; detail: string }): void => {
  try {
    cases.push({ name, ...run() })
  } catch (error) {
    cases.push({ name, pass: false, detail: `threw ${String(error).slice(0, 120)}` })
  }
}

addCase('(a) an unloaded cell (null) stays unknown - no verdict', () => {
  const status = statusFor(null)
  return { pass: status === 'unknown', detail: `status=${status} expected=unknown` }
})

addCase('(b) a loaded air cell falsifies the remembered resource', () => {
  const air = statusFor({ name: 'air', boundingBox: 'empty' })
  const cave = statusFor({ name: 'cave_air', boundingBox: 'empty' })
  return {
    pass: air === 'falsified' && cave === 'falsified',
    detail: `air=${air} cave_air=${cave} expected=falsified`,
  }
})

addCase('(c) a loaded fluid cell falsifies it too (resource flooded away)', () => {
  const water = statusFor({ name: 'water', boundingBox: 'empty' })
  return { pass: water === 'falsified', detail: `water=${water} expected=falsified` }
})

addCase('(d) a loaded different solid block still falsifies, and the real block is present', () => {
  const stone = statusFor({ name: 'stone', boundingBox: 'block' })
  const present = statusFor({ name: 'obsidian', boundingBox: 'block' })
  return {
    pass: stone === 'falsified' && present === 'present',
    detail: `stone=${stone} present=${present}`,
  }
})

let failed = 0
for (const testCase of cases) {
  if (!testCase.pass) failed += 1
  console.log(`${testCase.pass ? 'PASS' : 'FAIL'} ${testCase.name} :: ${testCase.detail}`)
}
console.log(`\n${cases.length - failed}/${cases.length} resource-absence cases passed`)
if (failed > 0) process.exit(1)
