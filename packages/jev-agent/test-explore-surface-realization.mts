import { describe, expect, test } from 'bun:test'
import { applyReachabilityGate, defaultCandidateOptions, generateGroundedCandidates, restrictCandidatesAtCriticalHealth } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { QueuedGoal } from './src/goalQueue.ts'
import { currentOptionContextForQueuedGoal } from './src/optionSpec.ts'
import type { DescentOption, WorldState } from './src/state.ts'

function scene(mode: 'surface' | 'cave' | null = 'surface', y = 24): WorldState {
  const body = { x: 3, y, z: 8 }
  const current: QueuedGoal = {
    id: 'search-1', kind: 'explore', description: `explore ${mode ?? 'nearby'} terrain`,
    targetItem: null, requiredCount: 1, startCount: 0, haveCount: 0,
    status: 'active', origin: 'llm', createdAt: 0, updatedAt: 0, detail: null,
    ...(mode === null ? {} : { optionInstanceId: `explore:${mode}`, optionTemplateId: `explore:${mode}` }),
  }
  return {
    schemaVersion: 1, tick: 1, timestampMs: 1_700_000_000_000,
    self: {
      username: 'surface-search', position: body, eyePosition: { ...body, y: y + 1.62 },
      yaw: 0, pitch: 0, onGround: true, health: 20, food: 20,
      gameMode: 'survival', dimension: 'overworld', isDay: true, heldItem: null,
    },
    inventory: { counts: { dirt: 64 }, slots: [{ name: 'dirt', count: 64, slot: 0 }], totalItems: 64 },
    entities: [], blocks: [],
    terrain: { standable: [body, { x: 5, y, z: 8 }, { x: 3, y: y - 1, z: 10 }, { x: 3, y: y + 1, z: 10 }] },
    craftingTables: [], furnaces: [], placementSpots: [], descent: [], stepCuts: [], recentEvents: [],
    // The legacy Mission observation remains item-valued; the active queue's
    // itemless surface intent owns candidate generation.
    goal: { id: 'mission', description: 'obtain obsidian', targetItem: 'obsidian', requiredCount: 10,
      startCount: 0, haveCount: 0, progress: 0, complete: false, startedAtMs: 0 },
    goalQueue: { ...emptyGoalQueueState(), depth: 1, empty: false, current, goals: [current] },
    signals: { consecutiveFailures: 0, lastFailureCode: null, lastPathStatus: 'idle', stalledMs: 0,
      lastPolicyConfidence: null, maxConcurrentActions: 0, escalationRecommended: false,
      failedCandidates: {}, knownResources: [] },
  }
}

function openLevelStep(state: WorldState): DescentOption {
  const body = state.self.position
  const step = { x: body.x, y: body.y, z: body.z + 1 }
  return { dir: 'S', mode: 'level', dx: 0, dz: 1, step, wall: step,
    head: { ...step, y: step.y + 1 }, floor: { ...step, y: step.y - 1 },
    wallSolid: false, headSolid: false, floorSolid: true, landingUsable: true,
    safe: true, reason: 'safe', digName: 'air', digHarvestTool: null, digHarvestTier: null, diggable: false }
}

function acquireBlockedRoute(state: WorldState, higher = false) {
  const body = state.self.position
  const target = { x: body.x, y: body.y + (higher ? 15 : 0), z: body.z + 4 }
  const blocked: Candidate = { id: 'WITHHELD_ROUTE', kind: 'MOVE', label: 'approach sensed target',
    target, targetName: null, targetEntityId: null, itemName: null, requiresTool: false,
    toolName: null, inReach: false, hasStandableAdjacent: true, meta: { tick: state.tick } }
  state.descent = [openLevelStep(state)]
  state.terrain.standable = [body, state.descent[0]!.step, target]
  return applyReachabilityGate([blocked], state, { ...defaultCandidateOptions,
    reachability: { memory: null, pathProbe: position =>
      position.x === target.x && position.y === target.y && position.z === target.z ? 'no_path' : 'reachable' } })
}

describe('explicit surface search realization', () => {
  test('underground surface search offers ascent and rejects unbridged level/down frontiers', () => {
    const state = scene()
    const before = structuredClone(state.goalQueue)
    const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
    const frontier = grounded.candidates.filter(c => c.meta.explore === true)
    expect(frontier.length).toBeGreaterThan(0)
    expect(frontier.every(c => c.target!.y > state.self.position.y)).toBe(true)
    expect(frontier.every(c => c.meta.purpose === 'search:explore:surface')).toBe(true)
    const ascent = grounded.candidates.find(c => c.meta.surfaceAscent === true)
    expect(ascent).toBeDefined()
    expect(ascent!.meta.vertical).toBe('pillar')
    expect(ascent!.meta.optionSkill).toBe('PREREQUISITE')
    expect(ascent!.meta.prerequisiteRole).toBe('surface_access')
    expect(ascent!.meta.ascentTargetY).toBeGreaterThan(state.self.position.y)
    expect(currentOptionContextForQueuedGoal(state.goalQueue!.current!)!.allowedSkills).toContain('PREREQUISITE')
    expect(state.goalQueue).toEqual(before)
    expect(state.goal.complete).toBe(false)
  })

  test('a sensed overhead blocker exposes the existing clearance prerequisite without a tool requirement', () => {
    const state = scene()
    const body = state.self.position
    state.inventory = { counts: {}, slots: [], totalItems: 0 }
    state.terrain.standable = [body, { x: body.x + 2, y: body.y, z: body.z }]
    state.stepCuts = [{ dir: 'E', dx: 1, dz: 0, cut: { x: body.x + 1, y: body.y + 1, z: body.z },
      step: { x: body.x + 1, y: body.y + 1, z: body.z }, name: 'stone', safe: false, reason: 'headroom',
      blockedBy: { pos: { x: body.x + 1, y: body.y + 2, z: body.z }, name: 'stone' } }]
    const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
    const clearance = grounded.candidates.find(c => c.meta.prerequisiteRole === 'surface_access' && c.kind === 'MINE')
    expect(clearance).toBeDefined()
    expect(clearance!.requiresTool).toBe(false)
    expect(clearance!.meta.optionSkill).toBe('PREREQUISITE')
    expect(clearance!.meta.purpose).toBe('search:explore:surface')
    expect(grounded.surfaceAscentRefusal?.reason).toBe('step_overhead')
    expect(grounded.candidates.some(c => c.meta.explore === true)).toBe(false)
  })

  test('no ascent capability yields an honest refusal rather than level exploration', () => {
    const state = scene()
    state.inventory = { counts: {}, slots: [], totalItems: 0 }
    state.terrain.standable = state.terrain.standable.filter(p => p.y <= state.self.position.y)
    const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
    expect(grounded.surfaceAscentRefusal?.reason).toBe('no_placeable')
    expect(grounded.candidates.some(c => c.meta.explore === true)).toBe(false)
    expect(grounded.candidates.some(c => c.meta.surfaceAscent === true)).toBe(false)
    expect(state.goal.complete).toBe(false)
  })

  test('a starving critical body retains the grounded surface-access offer', () => {
    const state = scene()
    state.self.health = 1
    state.self.food = 0
    const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
    const offered = restrictCandidatesAtCriticalHealth(state, grounded.candidates)
    expect(offered.some(c => c.meta.prerequisiteRole === 'surface_access')).toBe(true)
    expect(offered.some(c => c.meta.explore === true && c.target!.y <= state.self.position.y)).toBe(false)
  })

  test('cave and unspecified exploration retain grounded level frontiers', () => {
    for (const mode of ['cave', null] as const) {
      const state = scene(mode)
      const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
      expect(grounded.candidates.some(c => c.meta.explore === true && c.target!.y === state.self.position.y)).toBe(true)
      expect(grounded.surfaceAscentRefusal).toBeNull()
      expect(grounded.candidates.some(c => c.meta.surfaceAscent === true)).toBe(false)
    }
  })

  test('surface search at the surface band retains horizontal exploration; other dimensions do not acquire an Overworld altitude', () => {
    for (const dimension of ['overworld', 'the_nether']) {
      const state = scene('surface', dimension === 'overworld' ? 70 : 24)
      state.self.dimension = dimension
      const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
      expect(grounded.candidates.some(c => c.meta.explore === true && c.target!.y === state.self.position.y)).toBe(true)
      expect(grounded.candidates.some(c => c.meta.surfaceAscent === true)).toBe(false)
    }
  })

  test('route acquisition cannot reintroduce generic underground level search under surface mode', () => {
    const state = scene()
    const grounded = acquireBlockedRoute(state, true)
    expect(grounded.withheld.some(w => w.candidate.id === 'WITHHELD_ROUTE')).toBe(true)
    expect(grounded.candidates.some(c => c.meta.explore === true && c.target!.y <= state.self.position.y)).toBe(false)
    // The shared vertical remedy is still an admitted capability, chosen by pi.
    expect(grounded.candidates.some(c => c.kind === 'MOVE' && c.meta.vertical === 'pillar')).toBe(true)
  })

  test('generic recovery exploration cannot replay an already occupied open-level cell', () => {
    const state = scene('cave')
    const opened = openLevelStep(state).step
    state.signals.exploredCells = new Set([`p${opened.x}_${opened.y}_${opened.z}`])
    const grounded = acquireBlockedRoute(state)
    expect(grounded.candidates.some(c => c.meta.explore === true && c.target?.x === opened.x &&
      c.target.y === opened.y && c.target.z === opened.z)).toBe(false)
  })

  test('an unvisited forward level continuation remains available for cave exploration', () => {
    const state = scene('cave')
    const opened = openLevelStep(state).step
    const grounded = acquireBlockedRoute(state)
    const forward = grounded.candidates.find(c => c.target?.x === opened.x && c.target.y === opened.y && c.target.z === opened.z)
    expect(forward).toBeDefined()
    expect(forward!.meta.capabilityAcquisition).toBe(true)
    expect(forward!.label).not.toContain('previous dig')
    expect(forward!.meta.forced).toBeUndefined()
    expect(forward!.meta.selected).toBeUndefined()
  })
})
