// test-minecraft-truth.mts - Minecraft mechanics truth is decided by the
// deterministic registry, never by a hardcoded heuristic list.
//
// Regression for the audited V1 defect: `UNBREAKABLE` (state.ts) marked
// obsidian unbreakable although minecraft-data marks it `diggable:true` with
// diamond/netherite harvest tools, so an obsidian descent/step/headroom route
// was refused even while holding the diamond pickaxe the block actually needs.
//
//   bun run minecraft-truth-test
import { loadGameData, requiredPickaxeRank0, resolveHarvest } from './src/gameData.ts'
import { isBreakableSolidBlock } from './src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/** The five names the removed heuristic list called unbreakable. */
const REGISTRY_UNBREAKABLE = ['bedrock', 'barrier', 'end_portal', 'end_portal_frame', 'nether_portal']

addCase('obsidian is breakable per minecraft-data and needs a diamond pickaxe (rank 4)', () => {
  const reg = loadGameData()
  const harvest = resolveHarvest(reg, 'obsidian')
  const rank = requiredPickaxeRank0(reg, 'obsidian')
  const block = reg.blocksByName?.obsidian
  const pass =
    block?.diggable === true &&
    harvest.harvestTool === 'pickaxe' &&
    harvest.harvestTier === 4 &&
    rank === 4
  return {
    pass,
    detail: `diggable=${String(block?.diggable)} tool=${String(harvest.harvestTool)} rank0=${String(harvest.harvestTier)} requiredRank0=${String(rank)}`,
  }
})

addCase('the breakability predicate accepts an obsidian probe (the old heuristic cannot override it)', () => {
  const accepted = isBreakableSolidBlock({ diggable: true, boundingBox: 'block' })
  const empty = isBreakableSolidBlock({ diggable: true, boundingBox: 'empty' })
  const pass = accepted === true && empty === false
  return { pass, detail: `obsidianProbe=${String(accepted)} emptyProbe=${String(empty)}` }
})

addCase('all non-obsidian names of the old list stay refused by the registry predicate', () => {
  const reg = loadGameData()
  const observed = REGISTRY_UNBREAKABLE.map((name) => {
    const block = reg.blocksByName?.[name]
    const diggable = block?.diggable === true
    const predicate = block === undefined ? null : isBreakableSolidBlock({ diggable, boundingBox: 'block' })
    return `${name}:diggable=${String(block?.diggable)}:predicate=${String(predicate)}`
  })
  const pass = observed.every((line) => line.endsWith('diggable=false:predicate=false'))
  return { pass, detail: observed.join(' ') }
})

addCase('the predicate still refuses bedrock, barrier and portals with real registry rows', () => {
  const reg = loadGameData()
  const results = REGISTRY_UNBREAKABLE.map((name) => {
    const block = reg.blocksByName?.[name]
    return isBreakableSolidBlock({ diggable: block?.diggable === true, boundingBox: 'block' })
  })
  const pass = results.every((value) => value === false)
  return { pass, detail: `refused=[${REGISTRY_UNBREAKABLE.join(',')}]` }
})

let failures = 0
process.stdout.write('minecraft truth - registry data vs heuristic breakability\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} minecraft-truth cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
