// test-prereq-orphan-retire.mts - #prereq-orphan / #prereq-order regression.
//
// Live blocker (source `6ee333a`/`d5f969e`, runId `run-mub35qdr-1e1dh`): the
// durable GoalQueue ledger held a `protected=true core=true`
// `smelt:iron_ingot` row whose only dependent, `craft:flint_and_steel`, was
// already done and had consumed the ingot. The dead row stayed the queue head
// (`CANDIDATE_STARVATION blockedBy=precondition:station:furnace repeat=36`)
// while the real M2 next step, `collect:obsidian`, waited behind it. Mercury
// then patched the station rows in BEHIND the row that needed them.
//
// The fixture preserves the measured row/order shape and supplies an explicit
// accepted dependency-occurrence witness. Stable semantic Option identity is
// intentionally insufficient because it repeats across fresh replans.
//
// Cases:
//   (a) the measured ledger shape plus explicit causal occurrence -> the orphaned smelt is retired with
//       `PREREQ_RETIRED ... reason=all_dependents_resolved`, the station rows it
//       orphaned cascade, and the queue advances to `collect:obsidian`;
//   (b) a still-required prerequisite (live dependent) is NOT retired;
//   (c) a retired protected/core row is not silently dropped: it stays in the
//       durable ledger as `impossible` with a recording detail, and a protected
//       row that is still required survives untouched;
//   (d) the station rows for a genuinely needed smelt are ordered BEFORE it
//       (`PREREQ_REORDERED`), and nothing is dropped/completed.
//   (h) a fresh identical semantic Option has a distinct request occurrence,
//       survives JSON persistence, and cannot be retired by an old consumer;
//   (h2) ownerless legacy M2 rows stay visible rather than gaining inferred edges;
//   (i) a same-occurrence compiled prerequisite still retires after JSON restore.
//
// Run: bun test ./test-prereq-orphan-retire.mts
import { GoalQueue, PREREQ_REORDERED, PREREQ_RETIRED, setPrereqAuditSink } from './src/goalQueue.ts'
import type { GoalKind, GoalStatus, QueuedGoal } from './src/goalQueue.ts'
import { applyCompiledPlan, makeOptionSnapshot } from './src/optionSpec.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const FLINT_AND_STEEL_OWNER = 'prereq:req-flint-and-steel:system2:front_flint_and_steel'

function row(
  partial: Partial<QueuedGoal> & {
    id: string
    kind: GoalKind
    targetItem: string | null
    requiredCount: number
    status: GoalStatus
  },
): QueuedGoal {
  return {
    description: `${partial.kind} ${partial.requiredCount} x ${partial.targetItem ?? 'none'}`,
    targetY: null,
    dimension: null,
    startCount: 0,
    haveCount: 0,
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...partial,
  }
}

/**
 * The exact durable ledger measured live in `run-mub35qdr-1e1dh`
 * (`buddy-driver/buddy-ledger.json`), including the `g44..g47` station rows
 * Mercury patched in behind the smelt they were meant to unblock.
 */
function liveLedger(): QueuedGoal[] {
  return [
    row({ id: 'g1:collect:raw_iron', kind: 'collect', targetItem: 'raw_iron', requiredCount: 1, status: 'done', haveCount: 3, protected: true, core: true }),
    row({ id: 'g2:smelt:iron_ingot', kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 1, status: 'active', protected: true, core: true, semanticOptionInstanceId: 'system2:front_flint_and_steel', prerequisiteCausalOwnerIds: [FLINT_AND_STEEL_OWNER] }),
    row({ id: 'g3:collect:flint', kind: 'collect', targetItem: 'flint', requiredCount: 1, status: 'done', haveCount: 1, protected: true, core: true }),
    row({ id: 'g4:craft:flint_and_steel', kind: 'craft', targetItem: 'flint_and_steel', requiredCount: 1, status: 'done', haveCount: 1, protected: true, core: true, semanticOptionInstanceId: 'system2:front_flint_and_steel', prerequisiteCausalOwnerIds: [FLINT_AND_STEEL_OWNER] }),
    row({ id: 'g5:collect:obsidian', kind: 'collect', targetItem: 'obsidian', requiredCount: 10, status: 'active', protected: true, core: true }),
    row({ id: 'g6:place:obsidian', kind: 'place', targetItem: 'obsidian', requiredCount: 10, status: 'pending', protected: false, core: true }),
    row({ id: 'g7:place:nether_portal', kind: 'place', targetItem: 'nether_portal', requiredCount: 1, status: 'pending', protected: false, core: true }),
    row({ id: 'g44:craft:crafting_table', kind: 'craft', targetItem: 'crafting_table', requiredCount: 1, status: 'pending' }),
    row({ id: 'g45:place:crafting_table', kind: 'place', targetItem: 'crafting_table', requiredCount: 1, status: 'pending' }),
    row({ id: 'g46:craft:furnace', kind: 'craft', targetItem: 'furnace', requiredCount: 1, status: 'pending', semanticOptionInstanceId: 'system2:front_flint_and_steel', prerequisiteCausalOwnerIds: [FLINT_AND_STEEL_OWNER] }),
    row({ id: 'g47:place:furnace', kind: 'place', targetItem: 'furnace', requiredCount: 1, status: 'pending', semanticOptionInstanceId: 'system2:front_flint_and_steel', prerequisiteCausalOwnerIds: [FLINT_AND_STEEL_OWNER] }),
  ]
}

function restoreLiveLedger(lines: string[]): GoalQueue {
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  queue.restore({ counter: 47, goals: liveLedger(), revision: 7 })
  return queue
}

function marker(lines: readonly string[], prefix: string): string[] {
  return lines.filter((line) => line.startsWith(prefix))
}

addCase('(a) the exact live ledger retires the orphaned smelt and advances to collect:obsidian', () => {
  const lines: string[] = []
  const queue = restoreLiveLedger(lines)
  const goals = queue.state.goals
  const smelt = goals.find((goal) => goal.id === 'g2:smelt:iron_ingot')
  const retired = marker(lines, PREREQ_RETIRED)
  const smeltLine = retired.find((line) => line.includes('id=g2:smelt:iron_ingot'))
  const retiredIds = retired.map((line) => (line.match(/id=(\S+)/) ?? [])[1] ?? '')
  const pass =
    smelt?.status === 'impossible' &&
    smelt.detail?.includes('reason=all_dependents_resolved') === true &&
    smeltLine?.includes('item=iron_ingot') === true &&
    smeltLine?.includes('reason=all_dependents_resolved') === true &&
    smeltLine?.includes('dependents=1') === true &&
    smeltLine?.includes(`causalOwners=[${FLINT_AND_STEEL_OWNER}]`) === true &&
    smeltLine?.includes('consumers=[g4:craft:flint_and_steel]') === true &&
    smeltLine?.includes('protected=true') === true &&
    smeltLine?.includes('core=true') === true &&
    // the station rows the smelt orphaned cascade behind it
    retiredIds.includes('g46:craft:furnace') &&
    retiredIds.includes('g47:place:furnace') &&
    retiredIds.length === 3 &&
    queue.current?.id === 'g5:collect:obsidian' &&
    queue.current?.kind === 'collect' &&
    queue.current?.targetItem === 'obsidian'
  return {
    pass,
    detail: `current=${queue.current?.id ?? 'none'} retired=[${retiredIds.join(',')}] lines=[${retired.join(' | ')}]`,
  }
})

addCase('(b) a still-required prerequisite is NOT retired', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  queue.restore({
    counter: 3,
    goals: [
      row({ id: 'g1:collect:raw_iron', kind: 'collect', targetItem: 'raw_iron', requiredCount: 1, status: 'done', haveCount: 1 }),
      // smelt is live work: its consumer craft:flint_and_steel is still pending
      row({ id: 'g2:smelt:iron_ingot', kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 1, status: 'active', protected: true, core: true, semanticOptionInstanceId: 'system2:front_flint_and_steel', prerequisiteCausalOwnerIds: [FLINT_AND_STEEL_OWNER] }),
      row({ id: 'g3:craft:flint_and_steel', kind: 'craft', targetItem: 'flint_and_steel', requiredCount: 1, status: 'pending', semanticOptionInstanceId: 'system2:front_flint_and_steel', prerequisiteCausalOwnerIds: [FLINT_AND_STEEL_OWNER] }),
    ],
  })
  const smelt = queue.state.goals.find((goal) => goal.id === 'g2:smelt:iron_ingot')
  const pass =
    smelt?.status === 'active' &&
    marker(lines, PREREQ_RETIRED).length === 0 &&
    queue.current?.id === 'g2:smelt:iron_ingot'
  return {
    pass,
    detail: `smeltStatus=${smelt?.status} current=${queue.current?.id ?? 'none'} retired=${marker(lines, PREREQ_RETIRED).length}`,
  }
})

addCase('(c) a retired protected/core row is not silently dropped, and a required protected row survives', () => {
  const lines: string[] = []
  const queue = restoreLiveLedger(lines)
  const goals = queue.state.goals
  const smelt = goals.find((goal) => goal.id === 'g2:smelt:iron_ingot')
  const obsidian = goals.find((goal) => goal.id === 'g5:collect:obsidian')
  const frame = goals.find((goal) => goal.id === 'g6:place:obsidian')
  const portal = goals.find((goal) => goal.id === 'g7:place:nether_portal')
  const smeltStatus: string | undefined = smelt?.status
  const pass =
    // the retired row is retained in the durable ledger, explicitly marked
    smelt !== undefined &&
    smeltStatus !== 'done' &&
    smeltStatus === 'impossible' &&
    typeof smelt.detail === 'string' &&
    smelt.detail.includes('retired prerequisite') &&
    smelt.detail.includes('dependents=1') &&
    // the explicit audit line is the opposite of a silent drop
    marker(lines, PREREQ_RETIRED).some((line) => line.includes('id=g2:smelt:iron_ingot')) &&
    // required protected/core rows are untouched
    obsidian?.status === 'active' &&
    frame?.status === 'pending' &&
    portal?.status === 'pending' &&
    queue.state.done === 3
  return {
    pass,
    detail: `smelt=${smelt?.status}/${smelt?.detail ?? 'none'} obsidian=${obsidian?.status} frame=${frame?.status} portal=${portal?.status} done=${queue.state.done}`,
  }
})

addCase('(d) the station rows Mercury patches behind a needed active smelt are ordered before it', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  // 1. the smelt is the committed active head (genuinely needed: no dependent
  //    has consumed its target, so it is NOT retired).
  queue.applyPlan(
    [{ kind: 'smelt', description: 'smelt 1 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 1, protected: true }],
    'llm',
  )
  const smeltBefore = queue.current?.targetItem
  // 2. Mercury patches the station chain in BEHIND it (the measured live shape).
  queue.applyPlan(
    [
      { kind: 'craft', description: 'craft 1 x crafting_table', targetItem: 'crafting_table', requiredCount: 1 },
      { kind: 'place', description: 'place 1 x crafting_table', targetItem: 'crafting_table', requiredCount: 1 },
      { kind: 'craft', description: 'craft 1 x furnace', targetItem: 'furnace', requiredCount: 1 },
      { kind: 'place', description: 'place 1 x furnace', targetItem: 'furnace', requiredCount: 1 },
    ],
    'llm',
    'patch',
    { reason: 'mercury station patch' },
  )
  const unfinished = queue.state.goals.filter((goal) => goal.status === 'pending' || goal.status === 'active')
  const index = (kind: string, item: string): number =>
    unfinished.findIndex((goal) => goal.kind === kind && goal.targetItem === item)
  const craftFurnace = index('craft', 'furnace')
  const placeFurnace = index('place', 'furnace')
  const smelt = index('smelt', 'iron_ingot')
  const reordered = marker(lines, PREREQ_REORDERED)
  const pass =
    smeltBefore === 'iron_ingot' &&
    unfinished.length === 5 &&
    craftFurnace !== -1 &&
    placeFurnace !== -1 &&
    smelt !== -1 &&
    craftFurnace < placeFurnace &&
    placeFurnace < smelt &&
    reordered.some((line) => line.includes('item=furnace') && line.includes('before=')) &&
    unfinished.every((goal) => goal.status !== 'done' && goal.status !== 'impossible') &&
    // the needed smelt was kept, not dropped, and both station rows survive
    unfinished.filter((goal) => goal.targetItem === 'furnace').length === 2
  return {
    pass,
    detail: `headBefore=${smeltBefore} order=[${unfinished.map((goal) => `${goal.kind}:${goal.targetItem}`).join(' -> ')}] current=${queue.current?.description ?? 'none'} moves=[${reordered.join(' | ')}]`,
  }
})

addCase('(e) the live M3 shape: class-only fuel dependents do NOT retire a still-wanted smelt:charcoal', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  // The exact durable ledger measured live in run-mubobiq6-12onv (m3-live
  // 0c2f363): three DONE `smelt:iron_ingot` rows whose only relation to charcoal
  // is the generic `inventoryClassAtLeast fuel` precondition, plus the M3
  // frontier's own `smelt 1 x charcoal` row. The smelts burned oak_planks, so a
  // done consumer is NOT evidence that charcoal was consumed or is unwanted.
  queue.restore({
    counter: 87,
    goals: [
      row({ id: 'g62:smelt:iron_ingot', kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 1, status: 'done', haveCount: 1 }),
      row({ id: 'g64:smelt:iron_ingot', kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 1, status: 'done', haveCount: 1 }),
      row({ id: 'g69:smelt:iron_ingot', kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 3, status: 'done', haveCount: 3, core: true }),
      row({ id: 'g87:smelt:charcoal', kind: 'smelt', targetItem: 'charcoal', requiredCount: 1, status: 'pending', core: true }),
    ],
    revision: 9,
  })
  const charcoal = queue.state.goals.find((goal) => goal.id === 'g87:smelt:charcoal')
  const pass =
    charcoal?.status === 'active' &&
    marker(lines, PREREQ_RETIRED).length === 0 &&
    queue.current?.id === 'g87:smelt:charcoal' &&
    queue.current?.targetItem === 'charcoal' &&
    queue.state.depth === 1
  return {
    pass,
    detail: `charcoal=${charcoal?.status} current=${queue.current?.id ?? 'none'} depth=${queue.state.depth} retired=${marker(lines, PREREQ_RETIRED).length}`,
  }
})

addCase('(f) a fresh charcoal plan survives retired class-only history (no accumulation cascade)', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  // The live ledger accumulated `impossible` charcoal rows whose detail grew
  // dependents=3 -> 6: each retired charcoal row satisfied the NEXT row's own
  // `inventoryClassAtLeast fuel` precondition, so the class edge manufactured
  // fresh "dependents" forever. Neither a retired row nor a class match may feed
  // the orphan proof.
  queue.restore({
    counter: 92,
    goals: [
      row({ id: 'g62:smelt:iron_ingot', kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 1, status: 'done', haveCount: 1 }),
      row({ id: 'g64:smelt:iron_ingot', kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 1, status: 'done', haveCount: 1 }),
      row({ id: 'g69:smelt:iron_ingot', kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 3, status: 'done', haveCount: 3, core: true }),
      row({
        id: 'g89:smelt:charcoal',
        kind: 'smelt',
        targetItem: 'charcoal',
        requiredCount: 1,
        status: 'impossible',
        core: true,
        detail: 'retired prerequisite: reason=all_dependents_resolved dependents=3',
      }),
      row({
        id: 'g90:smelt:charcoal',
        kind: 'smelt',
        targetItem: 'charcoal',
        requiredCount: 1,
        status: 'impossible',
        detail: 'retired prerequisite: reason=all_dependents_resolved dependents=4',
      }),
    ],
    revision: 11,
  })
  const added = queue.applyPlan(
    [{ kind: 'smelt', description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1, core: true }],
    'llm',
    'replace',
    { reason: 'queue_empty', onProtection: (line) => lines.push(`[onProtection] ${line}`) },
  )
  const fresh = added[0]
  const pass =
    added.length === 1 &&
    fresh?.status === 'active' &&
    fresh?.detail === null &&
    queue.current?.id === fresh?.id &&
    queue.current?.targetItem === 'charcoal' &&
    queue.state.depth === 1 &&
    marker(lines, PREREQ_RETIRED).length === 0
  return {
    pass,
    detail: `added=${added.length} status=${fresh?.status} detail=${fresh?.detail ?? 'none'} current=${queue.current?.id ?? 'none'} depth=${queue.state.depth} retired=${marker(lines, PREREQ_RETIRED).length}`,
  }
})

addCase('(g) an EXACT done consumer still retires (the class fix does not disable genuine cleanup)', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  // `craft:flint_and_steel`'s `inventoryAtLeast iron_ingot` is an exact edge, so
  // the recorded run-mub35qdr-1e1dh retirement must stay intact even though the
  // iron smelt also carries a class fuel precondition.
  queue.restore({
    counter: 4,
    goals: [
      row({ id: 'g2:smelt:iron_ingot', kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 1, status: 'active', protected: true, core: true, semanticOptionInstanceId: 'system2:front_flint_and_steel', prerequisiteCausalOwnerIds: [FLINT_AND_STEEL_OWNER] }),
      row({ id: 'g4:craft:flint_and_steel', kind: 'craft', targetItem: 'flint_and_steel', requiredCount: 1, status: 'done', haveCount: 1, semanticOptionInstanceId: 'system2:front_flint_and_steel', prerequisiteCausalOwnerIds: [FLINT_AND_STEEL_OWNER] }),
      row({ id: 'g5:collect:obsidian', kind: 'collect', targetItem: 'obsidian', requiredCount: 10, status: 'pending', core: true }),
    ],
    revision: 3,
  })
  const smelt = queue.state.goals.find((goal) => goal.id === 'g2:smelt:iron_ingot')
  const retired = marker(lines, PREREQ_RETIRED)
  const pass =
    smelt?.status === 'impossible' &&
    smelt.detail?.includes('reason=all_dependents_resolved') === true &&
    retired.some((line) => line.includes('id=g2:smelt:iron_ingot') && line.includes('dependents=1')) &&
    queue.current?.id === 'g5:collect:obsidian'
  return {
    pass,
    detail: `smelt=${smelt?.status}/${smelt?.detail ?? 'none'} current=${queue.current?.id ?? 'none'} retired=${retired.length}`,
  }
})

addCase('(h) same semantic System2 identity on a fresh g210 occurrence survives historical done consumers after JSON restore', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const semanticOwner = 'system2:front_raw_iron'
  const snapshot = makeOptionSnapshot({ inventory: {}, toolRank: 0 })
  const oldPlan = applyCompiledPlan(
    [{ kind: 'collect', description: 'collect 1 x raw_iron', targetItem: 'raw_iron', requiredCount: 1, semanticOptionInstanceId: semanticOwner }],
    snapshot,
    { enabled: true, causalOccurrenceId: 'request-old' },
  )
  const oldQueue = new GoalQueue()
  const oldRows = oldQueue.applyPlan(oldPlan.goals, 'llm', 'replace')
  const historical = oldRows.find((goal) => goal.kind === 'collect' && goal.targetItem === 'raw_iron')
  if (historical === undefined) return { pass: false, detail: 'old Option expansion omitted raw_iron consumer' }
  historical.status = 'done'
  historical.haveCount = historical.requiredCount

  const freshPlan = applyCompiledPlan(
    [{ kind: 'craft', description: 'craft stone_pickaxe', targetItem: 'stone_pickaxe', requiredCount: 1, semanticOptionInstanceId: semanticOwner }],
    snapshot,
    { enabled: true, causalOccurrenceId: 'request-new' },
  )
  const freshQueue = new GoalQueue()
  const freshRows = freshQueue.applyPlan(freshPlan.goals, 'llm', 'replace')
  const fresh = freshRows.find((goal) => goal.kind === 'craft' && goal.targetItem === 'stone_pickaxe')
  if (fresh === undefined) return { pass: false, detail: 'fresh Option expansion omitted stone_pickaxe producer' }
  fresh.id = 'g210:craft:stone_pickaxe'

  const combined = new GoalQueue()
  combined.restore({ counter: 210, revision: 244, goals: [historical, fresh] })
  const persisted = JSON.parse(JSON.stringify(combined.snapshot()))
  const restored = new GoalQueue()
  restored.restore(persisted)
  const queuedFresh = restored.state.goals.find((goal) => goal.id === fresh.id)
  const ownersOverlap = (historical.prerequisiteCausalOwnerIds ?? []).some((owner) =>
    (fresh.prerequisiteCausalOwnerIds ?? []).includes(owner),
  )
  const pass =
    historical.semanticOptionInstanceId === fresh.semanticOptionInstanceId &&
    ownersOverlap === false &&
    queuedFresh?.status === 'active' &&
    queuedFresh.detail === null &&
    marker(lines, PREREQ_RETIRED).length === 0 &&
    restored.current?.id === fresh.id &&
    (queuedFresh.prerequisiteCausalOwnerIds ?? []).includes('prereq:request-new:craft:stone_pickaxe')
  return {
    pass,
    detail: `fresh=${queuedFresh?.status} semantic=${queuedFresh?.semanticOptionInstanceId ?? 'none'} oldCausal=${(historical.prerequisiteCausalOwnerIds ?? []).join(',')} freshCausal=${(queuedFresh?.prerequisiteCausalOwnerIds ?? []).join(',')} current=${restored.current?.id ?? 'none'} retired=${marker(lines, PREREQ_RETIRED).length}`,
  }
})

addCase('(h2) ownerless legacy M2 rows remain visible when no causal witness was persisted', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  queue.restore({
    counter: 4,
    revision: 7,
    goals: [
      row({ id: 'g1:collect:raw_iron', kind: 'collect', targetItem: 'raw_iron', requiredCount: 1, status: 'done', haveCount: 3 }),
      row({ id: 'g2:smelt:iron_ingot', kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 1, status: 'active', protected: true, core: true }),
      row({ id: 'g3:collect:flint', kind: 'collect', targetItem: 'flint', requiredCount: 1, status: 'done', haveCount: 1 }),
      row({ id: 'g4:craft:flint_and_steel', kind: 'craft', targetItem: 'flint_and_steel', requiredCount: 1, status: 'done', haveCount: 1 }),
      row({ id: 'g5:collect:obsidian', kind: 'collect', targetItem: 'obsidian', requiredCount: 10, status: 'active' }),
    ],
  })
  const legacyPrerequisite = queue.state.goals.find((goal) => goal.id === 'g2:smelt:iron_ingot')
  const pass =
    legacyPrerequisite?.status === 'active' &&
    legacyPrerequisite.prerequisiteCausalOwnerIds === undefined &&
    marker(lines, PREREQ_RETIRED).length === 0 &&
    queue.current?.id === legacyPrerequisite.id
  return {
    pass,
    detail: `legacy=${legacyPrerequisite?.status} owner=none current=${queue.current?.id ?? 'none'} retired=${marker(lines, PREREQ_RETIRED).length}`,
  }
})

addCase('(i) an Option-expanded prerequisite retires against its same-occurrence resolved consumer after JSON restore', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const compiled = applyCompiledPlan(
    [{ kind: 'collect', description: 'collect 1 x raw_iron', targetItem: 'raw_iron', requiredCount: 1 }],
    makeOptionSnapshot({ inventory: {}, toolRank: 0 }),
    { enabled: true, causalOccurrenceId: 'request-valid' },
  )
  const producerPlan = compiled.goals.find((goal) => goal.kind === 'craft' && goal.targetItem === 'stone_pickaxe')
  const consumerPlan = compiled.goals.find((goal) => goal.kind === 'collect' && goal.targetItem === 'raw_iron')
  if (producerPlan === undefined || consumerPlan === undefined) {
    return { pass: false, detail: `compiler did not produce stone_pickaxe/raw_iron: ${compiled.goals.map((goal) => `${goal.kind}:${goal.targetItem}`).join(',')}` }
  }
  const queue = new GoalQueue()
  const added = queue.applyPlan(compiled.goals, 'llm', 'replace')
  const producer = added.find((goal) => goal.targetItem === 'stone_pickaxe')
  const consumer = added.find((goal) => goal.targetItem === 'raw_iron')
  if (producer === undefined || consumer === undefined) {
    return { pass: false, detail: `queue omitted producer/consumer: ${added.map((goal) => `${goal.id}:${goal.targetItem}`).join(',')}` }
  }
  consumer.status = 'done'
  consumer.haveCount = consumer.requiredCount
  const persisted = JSON.parse(JSON.stringify(queue.snapshot()))
  const restored = new GoalQueue()
  restored.restore(persisted)
  const retired = marker(lines, PREREQ_RETIRED).find((line) => line.includes(`id=${producer.id}`)) ?? ''
  const queuedProducer = restored.state.goals.find((goal) => goal.id === producer.id)
  const sharedOwners = (producer.prerequisiteCausalOwnerIds ?? []).filter((owner) =>
    (consumer.prerequisiteCausalOwnerIds ?? []).includes(owner),
  )
  const pass =
    producerPlan.semanticOptionInstanceId === consumerPlan.semanticOptionInstanceId &&
    producer.semanticOptionInstanceId === consumer.semanticOptionInstanceId &&
    sharedOwners.includes('prereq:request-valid:collect:raw_iron') &&
    queuedProducer?.status === 'impossible' &&
    retired.includes(`causalOwners=[${sharedOwners[0]}]`) &&
    retired.includes(`consumers=[${consumer.id}]`)
  return {
    pass,
    detail: `producer=${queuedProducer?.status} semantic=${producer.semanticOptionInstanceId ?? 'none'} causal=${sharedOwners.join(',')} consumer=${consumer.id}/${consumer.status} retired=${retired || 'none'}`,
  }
})

let failures = 0
process.stdout.write('prerequisite orphan retirement / ordering\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
setPrereqAuditSink(null)
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} prerequisite reconciliation cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
