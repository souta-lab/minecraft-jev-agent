// test-dig-ground-truth.mts - regression fixture for the measured M3 blocker
// after the descend/approach leg was cleared (live, source 6a7fccd, m3-live):
//
//   HEARTBEAT pos=21.9,66.0,11.9 action=MOVE
//   ACTION n=2406 id=MINE:b26_66_9 kind=MINE phase=digging
//   TOOL_CHOICE block=obsidian tool=pickaxe reason=pickaxe_required tier=4
//   [executor] action#194 MINE:b26_66_9 FAILED {"failure":"dig_timeout",
//                                            "message":"dig timed out after 15000ms"}
//   CAUSAL ... candidateId=MINE:b26_66_9 verified=false status=failed
//             resource=obsidian progressDelta=0
//   failure streak 6/6 code=dig_timeout
//   FATAL code=MODEL_UNAVAILABLE context=mercury:no_progress
//
// The body had already ARRIVED: the obsidian at (26,66,9) is verified present
// (read-only scan, radius 80) and the diamond pickaxe was held (tier=4). The
// boundary is the dig budget, not the approach:
//
//   * this Leaf server reports `onGround=false` while a solid block is
//     underfoot (no 26.1 collision shapes; the same parity quirk `pillarUp`
//     diagnoses in executor.ts), so every outgoing position packet advertises
//     an airborne body;
//   * prismarine-block charges the vanilla `/5` airborne penalty on the break
//     speed, so obsidian is ~9.4s grounded but ~46.9s airborne;
//   * the executor's flat `digTimeoutMs` (15000ms) then aborts every attempt
//     as `dig_timeout` before the server ever lands the break.
//
// The fix routes `digBlock` through `withDigGroundCorrection`, which keeps the
// flag corrected from the block grid for the whole dig so the packets the
// server reads agree with the world, and emits the typed
// `DIG_GROUND_CORRECTED` marker.
//
// This fixture pins, in the existing style:
//   (a) FAIL-BEFORE: with the stale airborne flag the server-side obsidian
//       break time exceeds the flat budget (dig_timeout);
//   (b) PASS-AFTER: `withDigGroundCorrection` grounds the body across a
//       clientbound `onGround=false` reset for the whole dig, reports the
//       correction once, uninstalls after, and the grounded break time fits
//       inside the budget;
//   (c) no fake grounding: with no solid support the correction declines;
//   (d) the typed marker names the block and cell.
//
// Run: bun test ./test-dig-ground-truth.mts
import { createRequire } from 'node:module'
import { correctStandingOnGround } from './src/pillarJump.ts'
import type { JumpBotLike, SolidAt } from './src/pillarJump.ts'
import { defaultExecutorOptions, formatDigGroundCorrected, withDigGroundCorrection } from './src/executor.ts'

const require = createRequire(import.meta.url)

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}
const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const FEET_X = 26
const FEET_Z = 10
const FEET_Y = 66

/** Obsidian facts (minecraft-data / vanilla): hardness 50, diamond speed 8. */
const OBSIDIAN_HARDNESS = 50
const DIAMOND_PICKAXE_SPEED = 8
/** Vanilla: a correct tool harvests at /30, a wrong tool at /100. */
const HARVEST_MULTIPLIER = 30
/** Vanilla / prismarine-block: break speed is divided by 5 while airborne. */
const AIRBORNE_DIVISOR = 5

/** The server-side break time the executor's budget must cover (vanilla rule). */
function serverBreakMs(input: {
  hardness: number
  toolSpeed: number
  canHarvest: boolean
  onGround: boolean
}): number {
  const speed = input.onGround ? input.toolSpeed : input.toolSpeed / AIRBORNE_DIVISOR
  const multiplier = input.canHarvest ? HARVEST_MULTIPLIER : 100
  const delta = speed / input.hardness / multiplier
  return (1 / delta) * 1000 / 20
}

const GROUNDED_OBSIDIAN_MS = serverBreakMs({
  hardness: OBSIDIAN_HARDNESS,
  toolSpeed: DIAMOND_PICKAXE_SPEED,
  canHarvest: true,
  onGround: true,
})
const AIRBORNE_OBSIDIAN_MS = serverBreakMs({
  hardness: OBSIDIAN_HARDNESS,
  toolSpeed: DIAMOND_PICKAXE_SPEED,
  canHarvest: true,
  onGround: false,
})
const DIG_BUDGET_MS = defaultExecutorOptions.digTimeoutMs

/** A solid footing at `solidAtY`; the feet cell stays empty. */
function footingAt(solidAtY: number | null): SolidAt {
  return (x, y, z) => x === FEET_X && z === FEET_Z && y === solidAtY
}

interface FakeBot extends JumpBotLike {
  /** the clientbound `position` packet mineflayer's physics.js applies */
  packetReset(): void
  /** physicsTick after the packet reset (correction listeners run) */
  tick(): void
}

/**
 * Fake bot with the production ground-correction installation. `packetReset`
 * reproduces the clientbound position packet that mineflayer's physics.js
 * applies (onGround=false) before the correction gets to run.
 */
function createFakeBot(): FakeBot {
  const entity = {
    position: { x: FEET_X + 0.4, y: FEET_Y, z: FEET_Z + 0.3 },
    velocity: { y: 0 },
    onGround: false,
  }
  const listeners = new Set<() => void>()
  return {
    entity,
    physicsEnabled: true,
    setControlState() {},
    clearControlStates() {},
    on(event, listener) {
      if (event === 'physicsTick') listeners.add(listener)
    },
    removeListener(event, listener) {
      if (event === 'physicsTick') listeners.delete(listener)
    },
    packetReset() {
      entity.onGround = false
    },
    tick() {
      for (const listener of listeners) listener()
    },
  }
}

// --- (a) FAIL-BEFORE: the airborne break never fits the flat budget -----------

addCase('(a) with the stale airborne flag obsidian break time exceeds the dig budget', () => {
  return {
    pass: AIRBORNE_OBSIDIAN_MS > DIG_BUDGET_MS && GROUNDED_OBSIDIAN_MS < DIG_BUDGET_MS,
    detail: `grounded=${GROUNDED_OBSIDIAN_MS}ms airborne=${AIRBORNE_OBSIDIAN_MS}ms budget=${DIG_BUDGET_MS}ms -> stale flag aborts as dig_timeout`,
  }
})

addCase('(a) the airborne penalty is exactly the documented 5x', () => {
  return {
    pass: AIRBORNE_OBSIDIAN_MS === GROUNDED_OBSIDIAN_MS * AIRBORNE_DIVISOR,
    detail: `${GROUNDED_OBSIDIAN_MS}ms x ${AIRBORNE_DIVISOR} = ${AIRBORNE_OBSIDIAN_MS}ms`,
  }
})

// --- (b) PASS-AFTER: the dig seam grounds the body and fits the budget --------

addCase('(b) withDigGroundCorrection grounds the body across a clientbound reset for the whole dig', async () => {
  const bot = createFakeBot()
  const isSolid = footingAt(FEET_Y - 1)
  let correctedReports = 0
  const onGroundDuringDig = await withDigGroundCorrection(
    bot,
    isSolid,
    async () => {
      bot.packetReset()
      bot.tick()
      bot.packetReset()
      bot.tick()
      return bot.entity.onGround
    },
    () => {
      correctedReports += 1
    },
  )
  return {
    pass: onGroundDuringDig === true && correctedReports === 1 && GROUNDED_OBSIDIAN_MS < DIG_BUDGET_MS,
    detail: `onGroundDuringDig=${onGroundDuringDig} correctedReports=${correctedReports} grounded=${GROUNDED_OBSIDIAN_MS}ms < budget=${DIG_BUDGET_MS}ms`,
  }
})

addCase('(b) the correction is uninstalled after the dig', async () => {
  const bot = createFakeBot()
  const isSolid = footingAt(FEET_Y - 1)
  await withDigGroundCorrection(bot, isSolid, async () => undefined)
  bot.packetReset()
  bot.tick()
  return {
    pass: bot.entity.onGround === false,
    detail: `listeners removed; onGround after reset+tick=${bot.entity.onGround}`,
  }
})

addCase('(b) a direct correctStandingOnGround call also grounds a solid-footing body', () => {
  const bot = createFakeBot()
  const corrected = correctStandingOnGround(bot, footingAt(FEET_Y - 1))
  return {
    pass: corrected && bot.entity.onGround === true,
    detail: `corrected=${corrected} onGround=${bot.entity.onGround}`,
  }
})

// --- (c) no fake grounding without real support --------------------------------

addCase('(c) no solid footing: the dig seam declines and never fakes onGround', async () => {
  const bot = createFakeBot()
  let correctedReports = 0
  const onGroundDuringDig = await withDigGroundCorrection(
    bot,
    footingAt(null),
    async () => {
      bot.packetReset()
      bot.tick()
      bot.packetReset()
      bot.tick()
      return bot.entity.onGround
    },
    () => {
      correctedReports += 1
    },
  )
  return {
    pass: onGroundDuringDig === false && correctedReports === 0,
    detail: `onGroundDuringDig=${onGroundDuringDig} correctedReports=${correctedReports}`,
  }
})

// --- (d) the typed marker ------------------------------------------------------

addCase('(d) DIG_GROUND_CORRECTED names the block and cell', () => {
  const marker = formatDigGroundCorrected({ name: 'obsidian', position: { x: 26, y: 66, z: 9 } })
  return {
    pass: marker === 'DIG_GROUND_CORRECTED block=obsidian at=26,66,9',
    detail: marker,
  }
})

// --- the real data agrees that obsidian needs the diamond pickaxe --------------

addCase('(e) prismarine data: obsidian harvests only with the diamond pickaxe and keeps the 5x ratio', () => {
  const mcData = require('minecraft-data')('1.21.11')
  const Block = require('prismarine-block')('1.21.11')
  const obsidian = mcData.blocksByName['obsidian']
  const diamond = mcData.itemsByName['diamond_pickaxe']
  const block = Block.fromStateId(obsidian.minStateId, 0)
  const grounded = block.digTime(diamond.id, false, false, false, [], {})
  const airborne = block.digTime(diamond.id, false, false, true, [], {})
  const harvests = block.harvestTools !== undefined && block.harvestTools[diamond.id] === true
  return {
    pass:
      block.hardness === OBSIDIAN_HARDNESS &&
      harvests &&
      airborne === grounded * AIRBORNE_DIVISOR &&
      airborne > DIG_BUDGET_MS,
    detail: `hardness=${block.hardness} harvests=${harvests} client grounded=${grounded}ms airborne=${airborne}ms budget=${DIG_BUDGET_MS}ms`,
  }
})

let failures = 0
process.stdout.write('dig ground truth: the server-visible body state owns the break speed\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} dig-ground-truth cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
