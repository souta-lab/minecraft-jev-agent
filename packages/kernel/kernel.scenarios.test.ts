import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyKernelCommand,
  assertKernelInvariants,
  createKernelState,
  createTransitionContract,
  type CanonicalTransitionContract,
  type KernelCommand,
  type KernelEvent,
  type KernelState,
} from './kernel.ts'
import { KERNEL_SCENARIOS, type KernelScenarioDef, type KernelScenarioStep } from './scenarios.ts'
import { trustedContractCompiler, trustedController, trustedDispatcher, trustedMissionAuthority, trustedProgressEvaluator, trustedScheduler, trustedVerifier, trustedWitnessValidator, trustedWorldAdapter } from './kernel-internal/trusted-adapter.ts'

// Deterministic scenario lab interpreter. Every KERNEL_SCENARIOS row is data;
// this file is the only place that knows how to execute it. Scenarios drive
// the real reducer end-to-end — no mocks — so a PASS means the authority
// semantics the row declares are what the kernel actually does.

const world = { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 7 } as const
const verifier = { id: 'verifier:world', version: '1' } as const
const witnessValidator = { id: 'witness:generic', version: '1' } as const
const progress = { id: 'progress:generic', version: '1' } as const
const compiler = { id: 'compiler:test', version: '1' } as const
const missionAuthority = { id: 'mission:test', version: '1' } as const

function capability(state: KernelState, step: KernelScenarioStep): unknown {
  const role = step.as ?? 'scheduler'
  if (role === 'scheduler') return trustedScheduler()
  if (role === 'dispatcher') return trustedDispatcher()
  if (role === 'compiler') return trustedContractCompiler(compiler.id)
  if (role === 'missionAuthority') return trustedMissionAuthority(missionAuthority.id)
  if (role === 'progress') return trustedProgressEvaluator(progress.id)
  if (role === 'verifier') return trustedVerifier(verifier.id)
  if (role === 'witness') return trustedWitnessValidator(witnessValidator.id)
  if (role === 'clock') return trustedWorldAdapter('clock')
  if (role === 'runtime') return trustedWorldAdapter('runtime')
  if (role === 'world') return trustedWorldAdapter('world')
  if (role.startsWith('controller:')) {
    const id = role.slice('controller:'.length)
    return trustedController(id, state.transitionContracts[id] ?? '', state.generationId)
  }
  throw new Error(`unknown capability role ${role}`)
}
function roleFields(step: KernelScenarioStep): Record<string, unknown> {
  const role = step.as ?? 'scheduler'
  if (role === 'verifier') return { verifier }
  if (role === 'missionAuthority') return { authority: missionAuthority }
  if (role === 'progress') return { evaluator: progress }
  if (role === 'witness') return { validator: witnessValidator }
  return {}
}
function applyStep(state: KernelState, command: Record<string, unknown>, cap: unknown, expectFail: string | undefined, rejections: string[], events?: KernelEvent[]): KernelState {
  const result = applyKernelCommand(state, { ...command, capability: cap } as unknown as KernelCommand)
  if (expectFail !== undefined) {
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe(expectFail)
      expect(result.state).toBe(state)
      rejections.push(result.reason)
      return state
    }
    throw new Error('unreachable')
  }
  if (!result.ok) { rejections.push(result.reason); throw new Error(`${String(command.kind)}: ${result.reason}`) }
  events?.push(...result.events)
  assertKernelInvariants(result.state)
  return result.state
}

function runScenario(def: KernelScenarioDef): { state: KernelState; events: KernelEvent[]; rejections: string[] } {
  const contracts = def.contracts.map((spec) => createTransitionContract(spec))
  const registryDefinitions = [verifier, witnessValidator]
  let state = createKernelState({
    world: def.world, generationId: def.generationId, missionPredicates: def.missionPredicates,
    verifierRegistry: registryDefinitions, progressRegistry: [progress], contractCompilerRegistry: [compiler],
    missionAuthority, minResidencyMs: 250, preemptibleYieldBudgetMs: 50,
  })
  const events: KernelEvent[] = []
  const rejections: string[] = []
  const registerAdmit = (c: CanonicalTransitionContract) => {
    state = applyStep(state, { kind: 'REGISTER_TRANSITION', contract: c, compiler }, trustedContractCompiler(compiler.id), undefined, rejections, events)
    state = applyStep(state, { kind: 'ADMIT_TRANSITION', transitionId: c.transitionId }, trustedScheduler(), undefined, rejections, events)
  }
  for (const step of def.trace) {
    const contract = step.ref === undefined ? undefined : contracts[step.ref]
    switch (step.do) {
      case 'registerAdmit': {
        if (contract === undefined) throw new Error('registerAdmit requires ref')
        if (step.expectFail !== undefined) {
          state = applyStep(state, { kind: 'REGISTER_TRANSITION', contract, compiler }, trustedContractCompiler(compiler.id), step.expectFail, rejections, events)
          break
        }
        registerAdmit(contract); break
      }
      case 'activate': {
        if (contract === undefined) throw new Error('activate requires ref')
        registerAdmit(contract)
        state = applyStep(state, { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: contract.transitionId }, trustedScheduler(), step.expectFail, rejections, events)
        break
      }
      case 'acceptFacts': {
        state = applyStep(state, {
          kind: 'ACCEPT_VERIFIED_SNAPSHOT', verifier, materialChange: true, observedAtMonoMs: step.to ?? state.monotonicMs,
          facts: (step.facts ?? []).map((f) => ({ predicateId: f.predicateId, truth: f.truth ?? 'true', valueHash: f.valueHash ?? `hash:${f.predicateId}`, effectCommitId: f.effectCommitId ?? null })),
        }, trustedVerifier(verifier.id), step.expectFail, rejections, events)
        break
      }
      case 'advanceTime': {
        state = applyStep(state, { kind: 'ADVANCE_TIME', toMonoMs: step.to }, trustedWorldAdapter('clock'), step.expectFail, rejections, events)
        break
      }
      case 'issue': {
        if (contract === undefined || step.effect === undefined) throw new Error('issue requires ref and effect')
        state = applyStep(state, { kind: 'ISSUE_EFFECT', transitionId: contract.transitionId, effect: step.effect.kind, scope: step.effect.scope, ttlMs: step.effect.ttlMs ?? 100 }, trustedController(contract.transitionId, contract.contractHash, state.generationId), step.expectFail, rejections, events)
        break
      }
      case 'begin': {
        state = applyStep(state, { kind: 'BEGIN_EFFECT_DISPATCH', commitId: step.commitId }, trustedDispatcher(), step.expectFail, rejections, events)
        break
      }
      case 'reconcile': {
        state = applyStep(state, { kind: 'RECONCILE_EFFECT', commitId: step.commitId, observation: step.observation, factIds: step.factIds ?? [], verifier }, trustedVerifier(verifier.id), step.expectFail, rejections, events)
        break
      }
      case 'command': {
        if (step.command === undefined) throw new Error('command step requires command')
        state = applyStep(state, { ...step.command, ...roleFields(step) }, capability(state, step), step.expectFail, rejections, events)
        break
      }
      default: throw new Error(`unknown step ${(step as { do: string }).do}`)
    }
  }
  return { state, events, rejections }
}

describe('deterministic scenario lab — kernel traces', () => {
  for (const def of KERNEL_SCENARIOS) {
    test(`${def.id} (${def.origin})`, () => {
      const { state, events, rejections } = runScenario(def)
      const kinds = events.map((e) => e.kind)
      for (const [id, kind] of Object.entries(def.expect.terminalOutcomes ?? {})) {
        expect(state.transitions[id]?.terminalOutcome?.kind, `${def.id}: ${id} terminal outcome`).toBe(kind)
      }
      for (const [id, lifecycle] of Object.entries(def.expect.lifecycles ?? {})) {
        expect(state.transitions[id]?.lifecycle, `${def.id}: ${id} lifecycle`).toBe(lifecycle)
      }
      for (const [commitId, status] of Object.entries(def.expect.effectStatuses ?? {})) {
        expect(state.effects[commitId]?.status, `${def.id}: ${commitId} status`).toBe(status)
      }
      for (const forbidden of def.expect.forbiddenEvents ?? []) {
        expect(kinds, `${def.id}: forbidden event ${forbidden}`).not.toContain(forbidden)
      }
      for (const forbidden of def.expect.forbiddenRejections ?? []) {
        expect(rejections, `${def.id}: forbidden rejection ${forbidden}`).not.toContain(forbidden)
      }
      assertKernelInvariants(state)
    })
  }
})

// Registry freshness: SCENARIO-REGISTRY.json is a generated index over these
// definitions plus pointer rows to existing deterministic regression files.
// Drift in either direction is a failure, so the index can be trusted as the
// machine-readable scenario map.
function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stableJson(v)]))
  return value
}
export function scenarioRegistryRows(defs: readonly KernelScenarioDef[]) {
  return defs.map((def) => ({
    id: def.id, kind: 'kernelTrace' as const, surface: 'packages/kernel',
    origin: def.origin, hypothesis: def.hypothesis,
    defSha256: createHash('sha256').update(JSON.stringify(stableJson(def))).digest('hex'),
    expect: def.expect,
  }))
}

describe('scenario registry integrity', () => {
  const registryPath = join(__dirname, '../../docs/development/SCENARIO-REGISTRY.json')
  test('registry matches the live scenario definitions', () => {
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      schema: string; scenarios: { id: string; kind: string; defSha256?: string; expect?: unknown; files?: string[]; command?: string }[]
    }
    expect(registry.schema).toBe('vtr-scenario-registry/v1')
    const rows = scenarioRegistryRows(KERNEL_SCENARIOS)
    const traceRows = registry.scenarios.filter((r) => r.kind === 'kernelTrace')
    expect(traceRows.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort())
    for (const row of traceRows) {
      const expected = rows.find((r) => r.id === row.id)!
      expect(row.defSha256, `${row.id} defSha256`).toBe(expected.defSha256)
      expect(row.expect).toEqual(expected.expect)
    }
    for (const row of registry.scenarios.filter((r) => r.kind === 'regression')) {
      expect(typeof row.command).toBe('string')
      for (const file of row.files ?? []) {
        expect(existsSync(join(__dirname, '../..', file)), `${row.id} references missing file ${file}`).toBe(true)
      }
    }
  })
})
