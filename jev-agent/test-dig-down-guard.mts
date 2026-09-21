// test-dig-down-guard.mts - owner rule: a MINE must never dig the block the bot
// is standing on, and a MINE whose sensed target is already gone (air) must be
// refused, never silently "dug".
//
// Live report: the resident appeared to mine straight down from the surface
// (`kind=MINE phase=digging`, y 65 -> 54) with no vertical-safety marker in the
// log. The stock MINE path had no under-feet check at all:
//
//   state.ts buildStoneBlocks() walks each column from the surface down and
//   keeps the topmost *air-exposed* stone-like block. For the bot's own column
//   the feet cell is air, so the support block at `feet.y - 1` is exposed and
//   becomes a `stone` BlockState. candidates.ts mineCandidates() then sees
//   horizontal ~0 and vertical 1.0 (<= PICKUP_MINE_VERTICAL 1.5), so it emits
//   `MINE:<feet-1>`. Removing it drops the bot one block with no support check
//   -- the DESCEND "D" straight-down step already requires solid support at
//   feet-2, but the MINE path bypassed that entirely.
//
// Behaviour-level (public candidate generator + guard only), so the same file
// is RED on the stock tree and GREEN after the fix.
//
// Run: bun --test test-dig-down-guard.mts
import { blockId, defaultCandidateOptions, digsBotSupport, formatDigDownRefused, generateCandidates } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import { guardCandidate } from './src/policy.ts'
import type { GuardContext } from './src/policy.ts'
import type { Candidate } from './src/candidates.ts'
import type { BlockState, DescentOption, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'
import { readFileSync } from 'node:fs'

const SELF: Vec3Json = { x: 0.5, y: 10, z: 0.5 }
/** The cell the bot's feet occupy, and the support block directly below it. */
const FEET: Vec3Json = { x: 0, y: 10, z: 0 }
const SUPPORT: Vec3Json = { x: 0, y: 9, z: 0 }
/** A legitimate stone beside the bot (same horizontal level) - must be preserved. */
const BESIDE: Vec3Json = { x: 2, y: 10, z: 0 }

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_DIGDOWN',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'overworld',
    isDay: true,
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function stoneBlock(position: Vec3Json): BlockState {
  const distance = Math.hypot(position.x + 0.5 - SELF.x, position.z + 0.5 - SELF.z)
  return {
    kind: 'stone',
    name: 'stone',
    position,
    distance,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: false,
    adjacentStandable: null,
    yield: 'cobblestone',
    harvestTool: 'pickaxe',
    harvestTier: 1,
  }
}

/**
 * `collect 1 x cobblestone` while standing on a stone support block: the exact
 * case where buildStoneBlocks() records the block under the feet.
 */
function collectCobblestoneState(blocks: BlockState[], tick = 5): WorldState {
  return {
    schemaVersion: 1,
    tick,
    timestampMs: 1_700_000_000_000,
    self: self(SELF),
    inventory: inventory({ diamond_pickaxe: 1 }),
    entities: [],
    blocks,
    terrain: { standable: [FEET] },
    craftingTables: [],
    placementSpots: [],
    descent: [],
    goal: {
      id: 'collect:cobblestone',
      description: 'collect 1 x cobblestone',
      targetItem: 'cobblestone',
      requiredCount: 1,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue: emptyGoalQueueState(),
    recentEvents: [],
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastPathStatus: 'idle',
      stalledMs: 0,
      lastPolicyConfidence: null,
      maxConcurrentActions: 0,
      escalationRecommended: false,
      failedCandidates: {},
    },
  }
}

function guardContext(candidateIds: readonly string[]): GuardContext {
  return {
    phase: 'dig',
    candidateIds: new Set(candidateIds),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 10,
  }
}

// (a) the defect: the generator must not offer the bot's own support block as a
// MINE. This is the case that was RED on the stock tree.
{
  const state = collectCobblestoneState([stoneBlock(SUPPORT)])
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const ids = candidates.map((candidate) => candidate.id)
  const supportId = `MINE:${blockId('b', SUPPORT)}`
  check(
    'no MINE candidate targets the block directly beneath the feet',
    !ids.includes(supportId),
    `support=${supportId} mineIds=[${candidates.filter((c) => c.kind === 'MINE').map((c) => c.id).join(',')}]`,
  )
}

// (b) a MINE whose target is no longer sensed (already air / unverifiable) is
// refused by the deterministic guard with a typed reason instead of "dug".
{
  const state = collectCobblestoneState([stoneBlock(SUPPORT)])
  const staleId = `MINE:${blockId('b', { x: 0, y: 8, z: 0 })}` // never in state.blocks
  const stale: Candidate = {
    id: staleId,
    kind: 'MINE',
    label: 'stale mine',
    targetName: 'stone',
    target: { x: 0, y: 8, z: 0 },
    targetEntityId: null,
    itemName: null,
    requiresTool: true,
    toolName: 'pickaxe',
    inReach: true,
    hasStandableAdjacent: false,
    meta: { tick: 5, yieldItem: 'cobblestone' },
  }
  const result = guardCandidate(stale, state, guardContext([staleId]))
  const denied = result.ok === false && result.code === 'TARGET_GONE'
  check(
    'a MINE for an already-air/unverified target is refused (TARGET_GONE)',
    denied,
    `result=${result.ok ? 'ok' : `${result.code} ${result.reason}`}`,
  )
}

// (c) preserved: a legitimate stone beside the bot is still offered and
// accepted, so the new rule suppresses only the support cell.
{
  const state = collectCobblestoneState([stoneBlock(BESIDE)])
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const mine = candidates.find((candidate) => candidate.kind === 'MINE' && candidate.target?.x === BESIDE.x)
  const accepted = mine !== undefined && guardCandidate(mine, state, guardContext([mine.id])).ok === true
  check(
    'a MINE beside the feet is still offered and guard-accepted',
    accepted,
    `mine=${mine?.id ?? 'none'} accepted=${accepted}`,
  )
}

// (d) the shared truth + greppable marker the executor emits.
{
  const refusal = digsBotSupport(SELF, SUPPORT)
  const marker = refusal === null ? 'none' : formatDigDownRefused(refusal)
  const notSupport = digsBotSupport(SELF, BESIDE) === null
  check(
    'digsBotSupport flags the support cell and formatDigDownRefused emits DIG_DOWN_REFUSED',
    refusal?.reason === 'bot_support' && marker === 'DIG_DOWN_REFUSED reason=bot_support cell=0,9,0' && notSupport,
    `refusal=${refusal?.reason ?? 'none'} marker=${marker} besideRefused=${!notSupport}`,
  )
}

// (e) preserved: the controlled own-column DESCEND step (solid support at
// feet-2) is still offered; an unsafe down step ('floor already open') is not.
{
  const mkDown = (safe: boolean, reason: string): DescentOption => ({
    dir: 'D',
    mode: 'down',
    dx: 0,
    dz: 0,
    step: { x: 0, y: 9, z: 0 },
    wall: { x: 0, y: 10, z: 0 },
    head: { x: 0, y: 11, z: 0 },
    floor: { x: 0, y: 9, z: 0 },
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    safe,
    reason,
    digName: 'stone',
    diggable: true,
    digHarvestTool: 'pickaxe',
    digHarvestTier: 1,
  })
  const controlledState = collectCobblestoneState([stoneBlock(SUPPORT)])
  controlledState.descent = [mkDown(true, 'safe')]
  const controlledIds = generateCandidates(controlledState, defaultCandidateOptions).map((c) => c.id)

  const unsafeState = collectCobblestoneState([stoneBlock(SUPPORT)])
  unsafeState.descent = [mkDown(false, 'floor already open (uncontrolled fall)')]
  const unsafeIds = generateCandidates(unsafeState, defaultCandidateOptions).map((c) => c.id)

  const controlled = controlledIds.some((id) => id.startsWith('DESCEND:down:D:'))
  const unsafeOffered = unsafeIds.some((id) => id.startsWith('DESCEND:'))
  check(
    'the controlled own-column DESCEND remains available, the unsafe one is withheld',
    controlled && !unsafeOffered,
    `controlled=[${controlledIds.filter((id) => id.startsWith('DESCEND')).join(',')}] unsafe=[${unsafeIds.filter((id) => id.startsWith('DESCEND')).join(',')}]`,
  )
}

// (f) the executor path is wired to the same shared truth + marker (no live bot
// harness exists offline, so this pins the wiring at the source level).
{
  const executorSource = readFileSync(new URL('./src/executor.ts', import.meta.url), 'utf8')
  const wired =
    executorSource.includes('digsBotSupport(') &&
    executorSource.includes('formatDigDownRefused(') &&
    executorSource.includes("'dig_down_refused'")
  check(
    'executor.runMine refuses a support-cell MINE with the typed dig_down_refused marker',
    wired,
    `wired=${wired}`,
  )
}

process.stdout.write('-'.repeat(72) + '\n')
if (failures > 0) {
  process.stdout.write(`${failures} dig-down guard case(s) FAILED\n`)
  process.exit(1)
}
process.stdout.write('all dig-down guard cases passed\n')