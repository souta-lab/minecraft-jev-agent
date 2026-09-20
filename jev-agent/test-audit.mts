// test-audit.mts - acceptance tests A-H from the external architecture audit.
//
//   A. architecture consistency (doc question names == code; no phantom fields)
//   B. Boolean gating (probability bands, no provider confidence)
//   C. action-target coherence (action is the only authoritative choice)
//   D. epoch / coalescing (priority merge, critical revalidation, state hash)
//   E. monotonic subgoal completion
//   F. resource abstraction (semantic class -> concrete item)
//   G. LLM escalation control flow (continue / patch / replace / abort)
//   H. pickup + headroom gate
//
// Run: npm run audit-test
import { readFileSync } from 'node:fs'
import type { Bot } from 'mineflayer'
import { buildQuestions, booleanBand, decisionIdFrom, QUESTION_NAMES, shouldRetreatFrom } from './src/jev.ts'
import type { JevAnswer, JevResult } from './src/jev.ts'
import { CRITICAL_TRIGGERS, pickHigherPriority, questionSetForTrigger, TRIGGER_PRIORITY } from './src/controller.ts'
import { DecisionScheduler } from './src/scheduler.ts'
import { EventLogger } from './src/jev.ts'
import { stableStateHash } from './src/decisionlog.ts'
import { gateBoolean } from './src/gating.ts'
import { GoalQueue } from './src/goalQueue.ts'
import { headroomSufficient } from './src/executor.ts'
import { evaluateSummonConditions, LLM_SUMMON_REASONS } from './src/system2.ts'
import { isResourceClass, matchesResourceClass, resolveToAvailable, resourceMatches } from './src/resourceClass.ts'
import type { Candidate } from './src/candidates.ts'
import type { System2PlanRequest } from './src/system2.ts'
import type { TriggerEvent } from './src/scheduler.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const read = (path: string): string => readFileSync(path, 'utf8')

function candidate(id: string): Candidate {
  return {
    id,
    kind: 'MINE',
    label: `mine at ${id}`,
    targetName: 'oak_log',
    target: { x: 6, y: 63, z: -67 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: 'axe',
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1 },
  }
}

function booleanAnswer(probability: number, confidence: number | null = null): JevAnswer {
  return {
    name: 'should_retreat',
    type: 'boolean',
    value: probability,
    probability,
    confidence,
    probabilities: { true: probability, false: 1 - probability },
    legend: null,
    note: null,
  }
}

function jevResult(answers: Record<string, JevAnswer>): JevResult {
  return {
    callId: 'audit-call',
    policy: 'typesafe',
    source: 'jev',
    model: 'typesafe-ai/jev',
    latencyMs: 100,
    usage: null,
    answers,
  }
}

function trigger(triggerName: TriggerEvent['trigger'], priority: number): TriggerEvent {
  return { trigger: triggerName, detail: {}, ts: priority }
}

// A. Architecture consistency -------------------------------------------------
addCase('A. ARCHITECTURE.md question names match the code and reference no phantom fields', () => {
  const doc = read('../ARCHITECTURE.md')
  const missing = QUESTION_NAMES.filter((name) => !doc.includes(name))
  const controller = read('src/controller.ts')
  const referenced = new Set<string>()
  for (const match of controller.matchAll(/answers\.([a-z_]+)/g)) {
    if (match[1] !== undefined) referenced.add(match[1])
  }
  const phantom = [...referenced].filter((name) => !(QUESTION_NAMES as readonly string[]).includes(name))
  const legacy = ['need_llm', 'need_replan'].filter((name) => doc.includes(name))
  const pass = missing.length === 0 && phantom.length === 0 && legacy.length === 0
  return { pass, detail: `missing=${missing.join(',') || 'none'} phantom=${phantom.join(',') || 'none'} legacyInDoc=${legacy.join(',') || 'none'}` }
})

// B. Boolean gating -----------------------------------------------------------
addCase('B. boolean bands: 0.30/0.70 strong, in-between uncertain, confidence ignored', () => {
  const band = (p: number): string => String(booleanBand(p))
  const strongFalse = gateBoolean(booleanAnswer(0.3, null))
  const strongTrue = gateBoolean(booleanAnswer(0.7, null))
  const uncertainLow = gateBoolean(booleanAnswer(0.31, 0.99))
  const uncertainHigh = gateBoolean(booleanAnswer(0.69, 0.99))
  const pass =
    band(0.3) === 'strong_false' &&
    band(0.7) === 'strong_true' &&
    band(0.31) === 'uncertain' &&
    band(0.69) === 'uncertain' &&
    strongFalse.strong === true &&
    strongTrue.strong === true &&
    uncertainLow.uncertain === true &&
    uncertainHigh.uncertain === true &&
    booleanBand(null) === null
  return {
    pass,
    detail: `0.30=${band(0.3)} 0.70=${band(0.7)} 0.31=${band(0.31)} 0.69=${band(0.69)}`,
  }
})

// C. action-target coherence --------------------------------------------------
addCase('C. action is the only authoritative choice; target ids live inside candidates', () => {
  const questions = buildQuestions([candidate('MINE:b6_63_-67')])
  const noTargetQuestion = (questions as Record<string, unknown>).target === undefined
  const authority = decisionIdFrom(
    jevResult({
      action: { name: 'action', type: 'choice', value: 'MINE:b6_63_-67', probability: 1, confidence: 1, probabilities: {}, legend: null, note: null },
      target: { name: 'target', type: 'choice', value: 'MINE:b9_9_9', probability: 1, confidence: 1, probabilities: {}, legend: null, note: null },
    }),
  )
  const embedded = authority === 'MINE:b6_63_-67' && candidate('MINE:b6_63_-67').target !== null
  const executor = read('src/executor.ts')
  const executorReadsTargetAnswer = /answers\.target/.test(executor)
  return { pass: noTargetQuestion && embedded && !executorReadsTargetAnswer, detail: `targetQuestion=${!noTargetQuestion} authority=${authority} executorReadsTargetAnswer=${executorReadsTargetAnswer}` }
})

// D. epoch / coalescing -------------------------------------------------------
addCase('D. coalescing keeps the highest priority and critical triggers revalidate a stale decision', async () => {
  const critical = trigger('damage_taken', 10)
  const normal = trigger('inventory_changed', 6)
  const keptCritical = pickHigherPriority(critical, normal)
  const promoted = pickHigherPriority(normal, critical)
  const controller = `${read('src/controller.ts')}\n${read('src/controller-legacy.ts')}`
  const wired =
    controller.includes('criticalArrivedDuringFlight') &&
    controller.includes('hasCriticalTriggerDuringFlight') &&
    controller.includes('freshCandidates') &&
    controller.includes('guardDecision')
  const familyScoped = controller.includes('criticalThreatFamily(trigger)') && controller.includes('criticalThreatFamily(critical.trigger)')
  const revalidated = controller.includes('critical trigger arrived during the Jev flight; revalidating decision')
  const threatSet = questionSetForTrigger('damage_taken') === 'threat'
  const stateA = { tick: 1, timestampMs: 1, value: 'a' } as unknown as Parameters<typeof stableStateHash>[0]
  const stateAClock = { tick: 1, timestampMs: 999, value: 'a' } as unknown as Parameters<typeof stableStateHash>[0]
  const hashA = stableStateHash(stateA)
  const hashAClock = stableStateHash(stateAClock)
  const hashB = stableStateHash({ tick: 1, timestampMs: 1, value: 'b' } as unknown as Parameters<typeof stableStateHash>[0])

  const delivered: string[] = []
  const scheduler = new DecisionScheduler({} as unknown as Bot, new EventLogger(null, false), { coalesceMs: 20 })
  scheduler.onDecision((event) => delivered.push(event.trigger))
  scheduler.notify('inventory_changed', {})
  scheduler.notify('damage_taken', {})
  await new Promise((resolve) => setTimeout(resolve, 70))
  scheduler.stop()
  const bothDelivered = delivered.includes('inventory_changed') && delivered.includes('damage_taken')
  const criticalFirst = delivered.indexOf('damage_taken') < delivered.indexOf('inventory_changed')

  const pass =
    keptCritical.trigger === 'damage_taken' &&
    promoted.trigger === 'damage_taken' &&
    CRITICAL_TRIGGERS.has('mob_appeared') &&
    TRIGGER_PRIORITY.damage_taken > TRIGGER_PRIORITY.inventory_changed &&
    wired &&
    familyScoped &&
    revalidated &&
    threatSet &&
    hashA === hashAClock &&
    hashA !== hashB &&
    bothDelivered &&
    criticalFirst
  return { pass, detail: `kept=${keptCritical.trigger} promoted=${promoted.trigger} wired=${wired} familyScoped=${familyScoped} revalidated=${revalidated} threat=${threatSet} hashStable=${hashA === hashAClock} delivered=[${delivered.join(',')}]` }
})

// E. monotonic subgoal completion ---------------------------------------------
addCase('E. a completed collect subgoal never reverts when its items are later consumed', () => {
  const queue = new GoalQueue()
  queue.applyPlan(
    [
      { kind: 'collect', description: 'collect 3 x log', targetItem: 'oak_log', requiredCount: 3 },
      { kind: 'craft', description: 'craft 1 x oak_planks', targetItem: 'oak_planks', requiredCount: 1 },
    ],
    'llm',
  )
  queue.markProgress(3)
  const afterComplete = queue.state
  const collectStillDone = afterComplete.goals[0]?.status === 'done'
  queue.markProgress(0)
  const afterConsume = queue.state
  const stillDone = afterConsume.goals[0]?.status === 'done'
  const advanced = afterConsume.current?.targetItem === 'oak_planks'
  return { pass: collectStillDone && stillDone && advanced, detail: `afterComplete=${afterComplete.goals[0]?.status} afterConsume=${afterConsume.goals[0]?.status} current=${afterConsume.current?.targetItem}` }
})

// F. resource abstraction -----------------------------------------------------
addCase('F. resourceClass log resolves to the available concrete wood (birch)', () => {
  const classMatch = resourceMatches('birch_log', 'log') === true && resourceMatches('oak_log', 'log') === true
  const notClass = isResourceClass('oak_log') === false
  const resolved = resolveToAvailable('log', ['birch_log', 'spruce_log']) === 'birch_log'
  const food = matchesResourceClass('bread', 'food') && matchesResourceClass('oak_log', 'food') === false
  const candidates = read('src/candidates.ts')
  const wired = candidates.includes('resourceMatches(block.yield, focusItem)')
  const pass = classMatch && notClass && resolved && food && wired
  return { pass, detail: `log(birch)=${resourceMatches('birch_log', 'log')} resolved=${resolveToAvailable('log', ['birch_log'])} wired=${wired}` }
})

// G. LLM escalation control flow ----------------------------------------------
addCase('G. replan ops continue/patch/replace/abort reshape the queue correctly', () => {
  const make = (): GoalQueue => {
    const queue = new GoalQueue()
    queue.applyPlan(
      [
        { kind: 'collect', description: 'collect 1 x oak_log', targetItem: 'oak_log', requiredCount: 1 },
        { kind: 'craft', description: 'craft 1 x crafting_table', targetItem: 'crafting_table', requiredCount: 1 },
        { kind: 'collect', description: 'collect 1 x cobblestone', targetItem: 'cobblestone', requiredCount: 1 },
      ],
      'llm',
    )
    return queue
  }
  const appended = make()
  appended.markProgress(1)
  appended.applyPlan([{ kind: 'collect', description: 'collect 1 x iron_ore', targetItem: 'iron_ore', requiredCount: 1 }], 'llm', 'continue')
  const continueKeepsPending = appended.state.goals.some((goal) => goal.targetItem === 'cobblestone')

  const patched = make()
  patched.applyPlan([{ kind: 'collect', description: 'collect 1 x birch_log', targetItem: 'birch_log', requiredCount: 1 }], 'llm', 'patch')
  const patchDropsPending = !patched.state.goals.some((goal) => goal.targetItem === 'cobblestone') &&
    patched.state.goals.some((goal) => goal.targetItem === 'birch_log')

  const replaced = make()
  replaced.markProgress(1)
  replaced.applyPlan([{ kind: 'collect', description: 'collect 1 x bread', targetItem: 'bread', requiredCount: 1 }], 'llm', 'replace')
  const replaceKeepsDone = replaced.state.goals[0]?.status === 'done' && replaced.state.goals.length === 2

  const aborted = make()
  aborted.applyPlan([], 'llm', 'abort')
  const abortStops = aborted.state.goals.every((goal) => goal.status === 'impossible')

  const request: System2PlanRequest = {
    reason: 'no_progress',
    detail: 'test',
    tick: 1,
    goalQueueState: aborted.state,
    objective: { targetItem: 'oak_log', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [],
  }
  const reasons = evaluateSummonConditions({ queueEmpty: false, needLlm: true, actionImpossible: true, unknownSituation: false, noProgress: true })
  const escalation = LLM_SUMMON_REASONS.every((reason) => typeof reason === 'string') && reasons.includes('need_llm') && reasons.includes('no_progress')
  const pass = continueKeepsPending && patchDropsPending && replaceKeepsDone && abortStops && escalation
  return { pass, detail: `continue=${continueKeepsPending} patch=${patchDropsPending} replace=${replaceKeepsDone} abort=${abortStops} requestTick=${request.tick}` }
})

// H. pickup + headroom --------------------------------------------------------
addCase('H. stock pathfinder is the primary MOVE; actuator + headroom gate are the fallback; stock collectblock is the pickup path', () => {
  const two = headroomSufficient(true, true)
  const one = headroomSufficient(true, false)
  const none = headroomSufficient(false, false)
  const executor = read('src/executor.ts')
  const gateSites = (executor.match(/if \(!jumpAllowed\)/g) ?? []).length
  const wiredGate =
    executor.includes('private hasJumpHeadroom') &&
    executor.includes('private headroomAt') &&
    executor.includes('const jumpAllowed = landingHeadroom || currentHeadroom') &&
    executor.includes('this.headroomAt(climb.x, climb.top + 1, climb.z)') &&
    gateSites >= 2
  const stockMove = executor.includes('private async stockPathTo') && executor.includes('this.bot.pathfinder.setGoal(goal)')
  const stockFirst = executor.indexOf('await this.stockPathTo(target, epoch, signal, goalKind)') < executor.indexOf('await this.walkByControls(target, epoch, signal, {')
  const fallbackLogged = executor.includes('control-walk fallback')
  const controller = read('src/controller.ts')
  const defaultPathfinder = /actuation: 'pathfinder',/.test(controller) && /actuation: 'pathfinder',/.test(executor)
  const stock = executor.includes('this.bot.collectBlock.collect')
  const pluginLoaded = read('m2.mts').includes("from 'mineflayer-collectblock'") && read('m2.mts').includes('collectBlockPlugin')
  const pass = two && !one && !none && wiredGate && stockMove && stockFirst && fallbackLogged && defaultPathfinder && stock && pluginLoaded
  return { pass, detail: `headroom(2)=${two} headroom(1)=${one} gateSites=${gateSites} stockMove=${stockMove} stockFirst=${stockFirst} defaultPathfinder=${defaultPathfinder} stockCollect=${stock} pluginLoaded=${pluginLoaded}` }
})

// P2. stock release (no git pin) + version/locomotion findings documented ------
addCase('P2. Mineflayer is the stock published release (no git pin) and the 1.21.11 findings are documented', () => {
  const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> }
  const pin = pkg.dependencies?.mineflayer ?? ''
  const arch = read('../ARCHITECTURE.md')
  const controller = read('src/controller.ts')
  const released = /^\^\d+\.\d+\.\d+$/.test(pin) && !pin.includes('github:')
  const documented = arch.includes('1.21.11') && arch.includes('stock') && arch.includes('#4063')
  const lifecycle = controller.includes("this.bot.on('end'") && controller.includes("this.bot.on('kicked'") && controller.includes("this.bot.on('death'")
  const noReconnectClaim = !/reconnect/i.test(controller)
  const pass = released && documented && lifecycle && noReconnectClaim
  return { pass, detail: `released=${released} documented=${documented} lifecycle=${lifecycle} noReconnectClaim=${noReconnectClaim}` }
})

let failures = 0
process.stdout.write('external audit acceptance A-H + P2\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} audit cases passed\n`)
if (failures > 0) process.exit(1)
