// p27: the validated System2 WHAT said explore mode=surface, but the
// compiled semantic intent and durable queue row both became bare "explore".
// Exercise actual normalization -> Option roundtrip -> queue persistence.
import { test, expect } from 'bun:test'
import { plannedGoalsFromMercury, validateMercuryPlan } from './mercury-system2.ts'
import { currentOptionContextForQueuedGoal, optionSpecToPlannedGoal } from '../jev-agent/src/optionSpec.ts'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
import { buildSemanticProjection } from '../jev-agent/src/system2-plane.ts'
import type { System2PlaneHost } from '../jev-agent/src/system2-plane.ts'
import { makeGoal } from '../jev-agent/src/state.ts'
import type { WorldState } from '../jev-agent/src/state.ts'
import { projectionHash } from '../jev-agent/src/jev/semantic-projection.ts'

// Only the production projection boundary runs here: no executor, lifecycle
// mutation, fabricated CAN facts, provider call or SUCCESS assertion.
function projectQueue(queue: GoalQueue, goal = makeGoal('obsidian', 10)) {
  const current = queue.current
  const host = {
    goal,
    currentGoalKey: () => current === null ? `objective:${goal.targetItem}:${goal.requiredCount}`
      : `${current.kind}:${current.targetItem ?? current.description}:${current.requiredCount}`,
    signals: { consecutiveFailures: 0 },
    options: { worldEpoch: 1 },
    previousDecisionFacts: () => null,
    semanticFacts: () => [],
    recentSkillOutcomes: [],
    lastSemanticProjection: null,
    compressedSkillSteps: 0,
  } as unknown as System2PlaneHost
  const state = {
    goalQueue: queue.state,
    currentOption: current === null ? null : currentOptionContextForQueuedGoal(current),
    self: { health: 1, food: 0, dimension: 'minecraft:overworld' },
    inventory: { counts: { raw_iron: 16, coal: 8 } },
    blocks: [], entities: [], recentEvents: [], signals: {},
  } as unknown as WorldState
  return buildSemanticProjection(host, state, [], 0)
}

for (const mode of ['surface', 'cave'] as const) {
  test(`System2 explore ${mode} survives Option lowering and queue roundtrip`, () => {
    const validated = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'explore', mode }], reason: 'find a new route' })
    if (!validated.ok) throw new Error(validated.error)
    const goal = plannedGoalsFromMercury(validated.plan)[0]!
    const spec = goal.optionSpec!
    const id = `explore:${mode}`
    const intent = `explore ${mode} terrain`
    expect(spec.id).toBe(id)
    expect(spec.intent).toBe(intent)
    expect(spec.semanticOptionIntent).toBe(intent)
    const lowered = optionSpecToPlannedGoal(spec)
    expect(lowered.description).toBe(intent)
    expect(lowered.kind).toBe('explore')
    expect(lowered.targetItem ?? null).toBeNull()
    expect(lowered.targetY ?? null).toBeNull()
    const queue = new GoalQueue()
    queue.applyPlan([lowered], 'llm', 'replace')
    const restored = new GoalQueue()
    restored.restore(queue.snapshot())
    expect(restored.current!.optionSpec!.intent).toBe(intent)
    expect(restored.current!.semanticOptionInstanceId).toBe(queue.current!.semanticOptionInstanceId)
  })
}

test('legacy bare explore intent restores its already-authoritative mode without changing lifecycle or predicates', () => {
  const validated = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'explore', mode: 'surface' }], reason: 'new route' })
  if (!validated.ok) throw new Error(validated.error)
  const lowered = optionSpecToPlannedGoal(plannedGoalsFromMercury(validated.plan)[0]!.optionSpec!)
  const queue = new GoalQueue()
  queue.applyPlan([lowered], 'llm', 'replace')
  const snapshot = structuredClone(queue.snapshot())
  const old = snapshot.goals[0]!
  old.description = 'explore'
  old.semanticOptionIntent = 'explore'
  old.optionSpec!.intent = 'explore'
  old.optionSpec!.semanticOptionIntent = 'explore'
  const oldSpec = structuredClone(old.optionSpec!)
  const restored = new GoalQueue()
  restored.restore(snapshot)
  const actual = restored.current!
  expect(actual.description).toBe('explore surface terrain')
  expect(actual.semanticOptionIntent).toBe('explore surface terrain')
  expect(actual.optionSpec!.intent).toBe('explore surface terrain')
  expect(actual.status).toBe(old.status)
  expect(actual.optionInstanceId).toBe(old.optionInstanceId)
  expect(actual.optionSpec!.target).toEqual(oldSpec.target)
  expect(actual.optionSpec!.success).toEqual(oldSpec.success)
  expect(actual.optionSpec!.skills).toEqual(oldSpec.skills)
  expect(actual.optionSpec!.abortThreshold).toBe(oldSpec.abortThreshold)
  expect(snapshot.goals[0]!.description).toBe('explore')
})

test('a custom explore intent is retained verbatim on restore', () => {
  const validated = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'explore', mode: 'surface' }], reason: 'x' })
  if (!validated.ok) throw new Error(validated.error)
  const goal = plannedGoalsFromMercury(validated.plan)[0]!
  goal.description = 'explore a coastal surface for food'
  goal.semanticOptionIntent = goal.description
  goal.optionSpec!.intent = goal.description
  goal.optionSpec!.semanticOptionIntent = goal.description
  const queue = new GoalQueue()
  queue.applyPlan([goal], 'llm', 'replace')
  const restored = new GoalQueue()
  restored.restore(queue.snapshot())
  expect(restored.current!.description).toBe(goal.description)
  expect(restored.current!.optionSpec!.intent).toBe(goal.description)
})

test('active surface WHAT cannot inherit the unrelated compatibility inventory goal', () => {
  const validated = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'explore', mode: 'surface' }], reason: 'find food' })
  if (!validated.ok) throw new Error(validated.error)
  const queue = new GoalQueue()
  queue.applyPlan(plannedGoalsFromMercury(validated.plan), 'llm', 'patch')
  const unrelated = { ...makeGoal('obsidian', 10), haveCount: 10, progress: 1, complete: true }
  const projection = projectQueue(queue, unrelated)
  expect(projection.option.intent).toBe('explore surface terrain')
  expect(projection.goal).toEqual({
    key: 'explore:explore surface terrain:1',
    targetItem: null, have: 0, required: 1, complete: false, progress: 0,
  })
  expect(projectionHash(projectQueue(queue, makeGoal('diamond', 3)))).toBe(projectionHash(projection))
  expect(unrelated.complete).toBe(true)
  expect(queue.current!.status).toBe('active')
})

test('matched predicate truth and the no-Option compatibility goal keep their existing projection', () => {
  const queue = new GoalQueue()
  queue.applyPlan([{ kind: 'descend', description: 'descend to y16', targetY: 16 }], 'llm', 'replace')
  const matched = { ...makeGoal('', 1), id: queue.current!.id, haveCount: 1, progress: 1, complete: true }
  expect(projectQueue(queue, matched).goal.complete).toBe(true)
  expect(projectQueue(queue, matched).goal.progress).toBe(1)
  const empty = new GoalQueue()
  expect(projectQueue(empty).goal.targetItem).toBe('obsidian')
  expect(projectQueue(empty).goal.required).toBe(10)
})
