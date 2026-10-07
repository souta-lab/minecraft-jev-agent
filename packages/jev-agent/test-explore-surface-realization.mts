import { describe, expect, test } from 'bun:test'
import { defaultCandidateOptions, generateGroundedCandidates, restrictCandidatesAtCriticalHealth } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { QueuedGoal } from './src/goalQueue.ts'
import { currentOptionContextForQueuedGoal } from './src/optionSpec.ts'
import type { WorldState } from './src/state.ts'

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
})
