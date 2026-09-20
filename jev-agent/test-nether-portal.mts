// test-nether-portal.mts - issue #80 (M3): the typed Nether-portal plan path.
//
// Fully offline: no bot, no network, no clock. Proves the typed plan, the
// diamond-pickaxe gate on obsidian mining, the 4x5 frame shape validation, the
// frame -> light -> verify ordering, and the prerequisite supply when materials
// are missing.
import { GoalQueue } from './src/goalQueue.ts'
import type { PlannedGoal } from './src/goalQueue.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'
import { compilePlannedGoal, validateOptionSpec } from './src/optionSpec.ts'
import {
  DIAMOND_PICKAXE,
  FLINT,
  FLINT_AND_STEEL,
  NETHER_PORTAL,
  OBSIDIAN,
  OVERWORLD,
  PORTAL_FRAME_READY,
  PORTAL_LIT,
  PORTAL_VERIFIED,
  PORTAL_BLOCK_PLACED,
  PRECONDITION_MISSING,
  evaluatePortalPostcondition,
  formatPortalFrameReady,
  lightPortal,
  obsidianRequiredPickaxeRank,
  planNetherPortal,
  planObsidianMining,
  portalFrameLayout,
  simulatePortalPlan,
  validatePortalFrame,
} from './src/netherPortalPlan.ts'
import type {
  PortalBlockPosition,
  PortalCapabilityId,
  PortalPostconditionSnapshot,
  PortalStep,
} from './src/netherPortalPlan.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

function snapshot(overrides: Partial<PortalPostconditionSnapshot> = {}): PortalPostconditionSnapshot {
  return {
    inventory: {},
    toolRank: 0,
    frame: null,
    lit: false,
    litDimension: null,
    verified: false,
    ...overrides,
  }
}

function stepKinds(steps: readonly PortalStep[]): string[] {
  return steps.map((step) => step.kind)
}

function hasLog(logs: readonly string[], needle: string): boolean {
  return logs.some((line) => line.includes(needle))
}

// ---------------------------------------------------------------------------
// 1. typed plan kinds + post-conditions
// ---------------------------------------------------------------------------

addCase('typed portal plan: full inventory emits build -> light -> verify with code-owned capability ids', () => {
  const plan = planNetherPortal({
    inventory: { diamond_pickaxe: 1, flint_and_steel: 1, obsidian: 10 },
    toolRank: 4,
  })
  const kinds = stepKinds(plan.steps)
  const capabilityIds = plan.steps.map((step) => step.capabilityId)
  const allPostconditions = plan.steps.every((step) => typeof step.postcondition.kind === 'string')
  const pass =
    plan.ready &&
    plan.prerequisites.length === 0 &&
    kinds.join('>') === 'build_portal_frame>light_portal>verify_portal' &&
    capabilityIds.join(',') === 'build:nether_portal_frame,light:nether_portal,verify:nether_portal' &&
    allPostconditions
  return {
    pass,
    detail: `ready=${plan.ready} prereqs=${plan.prerequisites.length} steps=[${kinds.join('>')}] caps=[${capabilityIds.join(',')}]`,
  }
})

addCase('every typed step post-condition evaluates true for a satisfied world (and false otherwise)', () => {
  const validFrame = validatePortalFrame({ blocks: portalFrameLayout({ x: 0, y: 64, z: 0 }).frame })
  const buildStep = planNetherPortal({ inventory: {}, toolRank: 4 }).steps.find((step) => step.kind === 'build_portal_frame')
  const lightStep = planNetherPortal({ inventory: {}, toolRank: 4 }).steps.find((step) => step.kind === 'light_portal')
  const verifyStep = planNetherPortal({ inventory: {}, toolRank: 4 }).steps.find((step) => step.kind === 'verify_portal')
  if (buildStep === undefined || lightStep === undefined || verifyStep === undefined) {
    return { pass: false, detail: 'missing operation steps' }
  }
  const satisfied = snapshot({ inventory: { obsidian: 10 }, toolRank: 4, frame: validFrame, lit: true, litDimension: OVERWORLD, verified: true })
  const unsatisfied = snapshot({ inventory: { obsidian: 9 }, toolRank: 3, frame: null, lit: false, litDimension: null, verified: false })
  const pass =
    evaluatePortalPostcondition(buildStep.postcondition, satisfied) &&
    evaluatePortalPostcondition(lightStep.postcondition, satisfied) &&
    evaluatePortalPostcondition(verifyStep.postcondition, satisfied) &&
    !evaluatePortalPostcondition(buildStep.postcondition, unsatisfied) &&
    !evaluatePortalPostcondition(lightStep.postcondition, unsatisfied) &&
    !evaluatePortalPostcondition(verifyStep.postcondition, unsatisfied)
  return { pass, detail: `lit=${satisfied.lit} verified=${satisfied.verified} toolRank=${satisfied.toolRank} negToolRank=${unsatisfied.toolRank}` }
})

// ---------------------------------------------------------------------------
// 2. diamond-pickaxe dependency + obsidian gate
// ---------------------------------------------------------------------------

addCase('obsidian mining without a diamond pickaxe is refused: PRECONDITION_MISSING and no attempt', () => {
  const decision = planObsidianMining(3).attempted
  const refused = planObsidianMining(3)
  const allowed = planObsidianMining(4)
  const pass =
    refused.attempted === false &&
    refused.line === `${PRECONDITION_MISSING} tool=${DIAMOND_PICKAXE}` &&
    allowed.attempted === true &&
    allowed.line.startsWith('MINE_OBSIDIAN') &&
    obsidianRequiredPickaxeRank() === 4 &&
    decision === false
  return { pass, detail: `rank3=[${refused.line}] rank4=[${allowed.line}] requiredRank=${obsidianRequiredPickaxeRank()}` }
})

addCase('simulation refuses the obsidian dig with toolRank=3: no block placed, no portal lit', () => {
  const sim = simulatePortalPlan({ inventory: {}, toolRank: 3 })
  const pass =
    sim.miningAttempted === false &&
    sim.miningRefused === true &&
    hasLog(sim.logs, `${PRECONDITION_MISSING} tool=${DIAMOND_PICKAXE}`) &&
    !hasLog(sim.logs, 'MINE_OBSIDIAN') &&
    !hasLog(sim.logs, PORTAL_BLOCK_PLACED) &&
    !hasLog(sim.logs, PORTAL_LIT) &&
    sim.frame.shape === 'bad' &&
    sim.lit === false &&
    sim.verified === false
  return { pass, detail: sim.logs.join(' | ') }
})

addCase('planNetherPortal expresses the stone -> iron -> diamond pickaxe dependency before obsidian', () => {
  const plan = planNetherPortal({ inventory: {}, toolRank: 0 })
  const ids = plan.prerequisites.map((step) => step.capabilityId)
  const obsidianStep = plan.prerequisites.find((step) => step.capabilityId === 'collect:obsidian')
  const ironIndex = ids.indexOf('craft:iron_pickaxe')
  const diamondIndex = ids.indexOf('craft:diamond_pickaxe')
  const obsidianIndex = ids.indexOf('collect:obsidian')
  const pass =
    ironIndex >= 0 &&
    diamondIndex > ironIndex &&
    obsidianIndex > diamondIndex &&
    obsidianStep !== undefined &&
    obsidianStep.kind === 'collect' &&
    obsidianStep.requiredPickaxeRank === 4
  return { pass, detail: `ids=[${ids.join(',')}] obsidianRank=${obsidianStep?.kind === 'collect' ? obsidianStep.requiredPickaxeRank : 'n/a'}` }
})

// ---------------------------------------------------------------------------
// 3. frame shape validation
// ---------------------------------------------------------------------------

addCase('correct 4x5 frame validates shape=ok (10 corner-omitted blocks and full 14-block frame)', () => {
  const layout = portalFrameLayout({ x: 12, y: 64, z: -7 })
  const minimal = validatePortalFrame({ blocks: layout.frame })
  const full = validatePortalFrame({ blocks: [...layout.frame, ...layout.corners] })
  const pass =
    minimal.shape === 'ok' &&
    minimal.blocks === 10 &&
    minimal.interior.length === 6 &&
    minimal.lightPosition !== null &&
    full.shape === 'ok' &&
    full.blocks === 14
  return {
    pass,
    detail: `minimal=${formatPortalFrameReady(minimal)} full=${formatPortalFrameReady(full)} light=${minimal.lightPosition?.x},${minimal.lightPosition?.y},${minimal.lightPosition?.z}`,
  }
})

addCase('malformed frames validate shape=bad: missing edge, wrong width, filled interior, duplicate', () => {
  const layout = portalFrameLayout({ x: 0, y: 64, z: 0 })
  const missingEdge = validatePortalFrame({ blocks: layout.frame.slice(0, layout.frame.length - 1) })
  const wrongWidth = validatePortalFrame({ blocks: layout.frame.filter((block) => block.x !== 0) })
  const interiorCell = layout.interior[0]
  const filledInterior =
    interiorCell === undefined ? null : validatePortalFrame({ blocks: [...layout.frame, interiorCell] })
  const duplicate = validatePortalFrame({ blocks: [...layout.frame, layout.frame[0] ?? { x: 0, y: 64, z: 0 }] })
  const pass =
    missingEdge.shape === 'bad' &&
    wrongWidth.shape === 'bad' &&
    filledInterior !== null &&
    filledInterior.shape === 'bad' &&
    duplicate.shape === 'bad' &&
    formatPortalFrameReady(missingEdge) === `${PORTAL_FRAME_READY} blocks=${layout.frame.length - 1} shape=bad`
  return {
    pass,
    detail: `missing=${missingEdge.reason} width=${wrongWidth.reason} interior=${filledInterior?.reason} dup=${duplicate.reason} line=${formatPortalFrameReady(missingEdge)}`,
  }
})

// ---------------------------------------------------------------------------
// 4. end-to-end: frame -> light -> verify
// ---------------------------------------------------------------------------

addCase('end-to-end simulation: valid frame -> PORTAL_LIT -> PORTAL_VERIFIED=true', () => {
  const sim = simulatePortalPlan({
    inventory: { flint_and_steel: 1, obsidian: 10 },
    toolRank: 4,
    hasFlintAndSteel: true,
  })
  const lightLine = sim.logs.find((line) => line.startsWith(PORTAL_LIT))
  const frameLine = sim.logs.find((line) => line.startsWith(PORTAL_FRAME_READY))
  const pass =
    frameLine === `${PORTAL_FRAME_READY} blocks=10 shape=ok` &&
    lightLine !== undefined &&
    lightLine.startsWith(`${PORTAL_LIT} pos=`) &&
    lightLine.includes('dimension=minecraft:overworld') &&
    hasLog(sim.logs, `${PORTAL_VERIFIED}=true`) &&
    sim.lit &&
    sim.verified &&
    sim.frame.shape === 'ok' &&
    sim.logs.filter((line) => line.startsWith(PORTAL_BLOCK_PLACED)).length === 10 &&
    sim.logs.indexOf(lightLine ?? '') > sim.logs.indexOf(frameLine ?? '')
  return { pass, detail: sim.logs.join(' | ') }
})

addCase('a frame that fails validation is never lit and never verified', () => {
  const layout = portalFrameLayout({ x: 0, y: 64, z: 0 })
  const malformed: PortalBlockPosition[] = layout.frame.slice(0, layout.frame.length - 1)
  const sim = simulatePortalPlan({
    inventory: { flint_and_steel: 1 },
    toolRank: 4,
    frame: malformed,
    hasFlintAndSteel: true,
  })
  const pass =
    sim.frame.shape === 'bad' &&
    hasLog(sim.logs, `${PORTAL_FRAME_READY} blocks=${malformed.length} shape=bad`) &&
    !hasLog(sim.logs, PORTAL_LIT) &&
    !hasLog(sim.logs, `${PORTAL_VERIFIED}=true`) &&
    sim.lit === false &&
    sim.verified === false
  return { pass, detail: sim.logs.join(' | ') }
})

addCase('lighting without flint_and_steel is refused with PRECONDITION_MISSING (frame not lit)', () => {
  const frame = validatePortalFrame({ blocks: portalFrameLayout({ x: 0, y: 64, z: 0 }).frame })
  const lighting = lightPortal({ frame, hasFlintAndSteel: false })
  const sim = simulatePortalPlan({ inventory: {}, toolRank: 4, hasFlintAndSteel: false })
  const pass =
    lighting.lit === false &&
    lighting.line === `${PRECONDITION_MISSING} tool=${FLINT_AND_STEEL}` &&
    hasLog(sim.logs, `${PRECONDITION_MISSING} tool=${FLINT_AND_STEEL}`) &&
    !hasLog(sim.logs, PORTAL_LIT) &&
    sim.lit === false &&
    sim.verified === false
  return { pass, detail: `${lighting.line} || ${sim.logs.join(' | ')}` }
})

// ---------------------------------------------------------------------------
// 5. ladder prerequisite supply (#12/#73 generalization)
// ---------------------------------------------------------------------------

addCase('missing materials supply the flint/iron/diamond prerequisite chain instead of stalling', () => {
  const plan = planNetherPortal({ inventory: {}, toolRank: 0 })
  const ids = new Set(plan.prerequisites.map((step) => step.capabilityId))
  const required: PortalCapabilityId[] = ['collect:raw_iron', 'smelt:iron_ingot', 'collect:flint', 'craft:flint_and_steel', 'craft:iron_pickaxe', 'collect:diamond', 'craft:diamond_pickaxe', 'collect:obsidian']
  const missing = required.filter((id) => !ids.has(id))
  const queue = new GoalQueue()
  queue.applyPlan(plan.goals, 'mechanical', 'replace')
  const goalItems = plan.goals.map((goal) => goal.targetItem)
  const pass =
    missing.length === 0 &&
    plan.ready === false &&
    plan.goals.length > 0 &&
    queue.state.empty === false &&
    goalItems.includes(FLINT) &&
    goalItems.includes('iron_ingot') &&
    goalItems.includes('diamond') &&
    goalItems.includes(OBSIDIAN) &&
    plan.goals.some((goal) => goal.kind === 'place' && goal.targetItem === OBSIDIAN && goal.description.includes('build the')) &&
    !plan.goals.some((goal) => goal.description.includes('build the') && goal.targetItem === NETHER_PORTAL)
  return {
    pass,
    detail: `missing=[${missing.join(',')}] goals=${plan.goals.length} queueEmpty=${queue.state.empty} items=[${goalItems.join(',')}]`,
  }
})

addCase('a fully supplied inventory is ready: no prerequisites, only the portal operations', () => {
  const plan = planNetherPortal({
    inventory: { diamond_pickaxe: 1, flint_and_steel: 1, obsidian: 10, diamond: 3, iron_ingot: 3, flint: 1 },
    toolRank: 4,
  })
  const pass = plan.ready && plan.prerequisites.length === 0 && stepKinds(plan.steps).join('>') === 'build_portal_frame>light_portal>verify_portal'
  return { pass, detail: `ready=${plan.ready} prereqs=${plan.prerequisites.length} steps=[${stepKinds(plan.steps).join('>')}]` }
})

addCase('a sensed partial frame counts toward obsidian requirements without borrowing inventory truth', () => {
  const plan = planNetherPortal({
    inventory: { diamond_pickaxe: 1, flint_and_steel: 1, obsidian: 3 },
    toolRank: 4,
    existingFrameBlocks: 7,
  })
  const obsidianPrereq = plan.prerequisites.find((step) => step.capabilityId === 'collect:obsidian')
  const pass = plan.ready && obsidianPrereq === undefined && plan.operations[0]?.kind === 'build_portal_frame'
  return {
    pass,
    detail: `ready=${plan.ready} prereqs=[${plan.prerequisites.map((step) => step.description).join('|')}] existing=7 held=3`,
  }
})

addCase('every emitted PlannedGoal keeps an explicit typed goal kind that compiles to a valid OptionSpec', () => {
  const plan = planNetherPortal({ inventory: {}, toolRank: 0 })
  const allowedKinds = new Set(['collect', 'craft', 'smelt', 'place'])
  const allTyped = plan.goals.every((goal) => allowedKinds.has(goal.kind))
  const specs = plan.goals.map((goal: PlannedGoal) => compilePlannedGoal(goal))
  const allValid = specs.every((spec) => validateOptionSpec(spec).length === 0)
  const kinds = plan.goals.map((goal) => goal.kind)
  return {
    pass: allTyped && allValid && kinds.includes('place'),
    detail: `kinds=[${kinds.join(',')}] specsValid=${allValid}`,
  }
})

addCase('portal acceptance markers reach the host event sink with typed details', () => {
  const required = ['PORTAL_BLOCK_PLACED', 'PORTAL_FRAME_READY', 'PORTAL_LIT', 'PORTAL_VERIFIED']
  const mirrored = required.filter((marker) => MIRRORED_MARKERS.has(marker))
  return {
    pass: mirrored.length === required.length,
    detail: `mirrored=[${mirrored.join(',')}] required=[${required.join(',')}]`,
  }
})

let failures = 0
process.stdout.write('Nether portal typed plan (#80)\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} nether-portal cases passed\n`)
if (failures > 0) process.exit(1)
