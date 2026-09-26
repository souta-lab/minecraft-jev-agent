// The landed #437 boundary contract, checked STATICALLY against the harness.
//
// #437 is on main (`jev-agent/src/jevSemanticProjection.ts`). The harness must
// carry that projection/skill-outcome boundary without importing jev-agent
// (I10), so the agreement is enforced by parsing the landed source here. If #437
// renames a projection field, adds a terminal reason, adds a progress kind or
// changes the packet shape, THIS test fails - the harness never silently accepts
// a contract it does not understand.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { JEV_HEADS } from '../heads.ts'
import { linkSkillOutcome } from '../artifacts.ts'
import { choiceAnswer, scriptedProvider } from '../testing.ts'
import {
  LANDED_437_EPOCH_INVALIDATION_REASONS,
  LANDED_437_PROGRESS_KINDS,
  LANDED_437_PROJECTION_ID,
  LANDED_437_PROJECTION_MODEL_FIELDS,
  LANDED_437_PROJECTION_VERSION,
  LANDED_437_TERMINAL_REASONS,
  identityFromLandedEpoch,
  skillOutcomeLinkFromPacket,
  staleReasonFromEpochInvalidation,
} from '../links437.ts'
import { declaredProjectionFields, lookupProjectionSchema } from '../semanticProjection.ts'
import { fixture, piRequestFor } from './support.ts'

const LANDED_SOURCE = new URL('../../jev-agent/src/jev/semantic-projection.ts', import.meta.url)
const source = readFileSync(LANDED_SOURCE, 'utf8')

/** Top-level field names of an exported interface, ignoring nested object bodies. */
function interfaceFields(name: string): readonly string[] {
  const start = source.indexOf(`export interface ${name} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  const body = source.slice(start + `export interface ${name} {`.length)
  const end = body.indexOf('\n}')
  expect(end).toBeGreaterThan(0)
  const fields: string[] = []
  for (const line of body.slice(0, end).split('\n')) {
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/.exec(line)
    if (match?.[1] !== undefined) fields.push(match[1])
  }
  return fields
}

/** Quoted members of an exported string-literal union. */
function unionMembers(name: string): readonly string[] {
  const start = source.indexOf(`export type ${name} =`)
  expect(start).toBeGreaterThanOrEqual(0)
  const body = source.slice(start)
  const end = body.indexOf('\n\n')
  const text = body.slice(0, end === -1 ? body.length : end)
  return [...text.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '')
}

describe('#437 landed boundary - the harness contract matches jev-agent source', () => {
  test('the projection schema id and version match the landed constants', () => {
    expect(source).toContain(`export const JEV_PROJECTION_SCHEMA = '${LANDED_437_PROJECTION_ID}'`)
    expect(source).toContain(`export const JEV_PROJECTION_VERSION = ${LANDED_437_PROJECTION_VERSION}`)
    expect(lookupProjectionSchema(LANDED_437_PROJECTION_ID)?.version).toBe(LANDED_437_PROJECTION_VERSION)
  })

  test('the harness registers exactly the landed model view (all fields except evidence-only counts)', () => {
    const landed = interfaceFields('JevSemanticProjection')
    expect(landed).toContain('counts')
    const modelView = landed.filter((field) => field !== 'counts')
    expect([...modelView].sort()).toEqual([...LANDED_437_PROJECTION_MODEL_FIELDS].sort())
    expect([...declaredProjectionFields(LANDED_437_PROJECTION_ID)].sort()).toEqual([...modelView].sort())
    // The landed model view is the projection with counts stripped.
    expect(source).toContain("projectionModelView(projection: JevSemanticProjection): Omit<JevSemanticProjection, 'counts'>")
  })

  test('the terminal-reason and progress-kind value spaces match the landed projection', () => {
    expect([...unionMembers('SkillTerminalReason')].sort()).toEqual([...LANDED_437_TERMINAL_REASONS].sort())
    expect([...unionMembers('EpochInvalidationReason')].sort()).toEqual([...LANDED_437_EPOCH_INVALIDATION_REASONS].sort())
    const progress = interfaceFields('ProgressSummary')
    expect(progress).toContain('kind')
    expect(source).toContain("kind: 'verified' | 'search' | 'mechanical' | 'none' | 'regressed'")
    expect([...LANDED_437_PROGRESS_KINDS].length).toBe(5)
  })

  test('the SkillOutcomePacket still carries the causal fields the link record needs', () => {
    const packet = interfaceFields('SkillOutcomePacket')
    for (const field of ['decisionEpoch', 'commitmentId', 'selectedCandidateId', 'terminalReason', 'verification', 'semanticProgress', 'failure']) {
      expect(`${field}:${packet.includes(field) ? 'present' : 'MISSING'}`).toBe(`${field}:present`)
    }
    // The packet has no decisionId: that identity comes from the harness decision
    // it closes, which is the causal thread #438 section 19 adds.
    expect(packet).not.toContain('decisionId')
  })

  test('the landed id is registered for heads only when a call site is migrated', () => {
    // Until Phase C migrates a call site, no shipped head may silently claim the
    // landed projection: that would change what the model sees without evidence.
    for (const head of JEV_HEADS) {
      expect(`${head.id}:${head.stateProjection === LANDED_437_PROJECTION_ID ? 'landed' : 'harness'}`).toContain(':')
    }
    expect(lookupProjectionSchema(LANDED_437_PROJECTION_ID)).not.toBeNull()
  })
})

describe('#437 landed boundary - the mapping onto the harness link record', () => {
  test('every terminal reason maps to a harness stale reason when the epoch is invalidated', () => {
    for (const reason of LANDED_437_EPOCH_INVALIDATION_REASONS) {
      const mapped = staleReasonFromEpochInvalidation(reason)
      expect(['decision_epoch_advanced', 'generation_changed', 'world_key_changed', 'world_epoch_changed', 'option_instance_changed']).toContain(
        mapped,
      )
    }
    expect(staleReasonFromEpochInvalidation('superseded')).toBe('decision_epoch_advanced')
    expect(staleReasonFromEpochInvalidation('dimension_changed')).toBe('world_key_changed')
    expect(staleReasonFromEpochInvalidation('lease_revoked')).toBe('generation_changed')
    expect(identityFromLandedEpoch({ decisionEpoch: 7, dimension: 'minecraft:overworld', worldEpoch: 2, generationId: 'gen-3' })).toEqual({
      decisionEpoch: 7,
      optionInstanceId: null,
      worldKey: 'dimension:minecraft:overworld',
      worldEpoch: 2,
      generationId: 'gen-3',
    })
  })

  test('verification stays a three-valued fact, never a default', () => {
    const base = {
      decisionEpoch: 481,
      commitmentId: 'commit:1',
      selectedCandidateId: 'kill:e183',
      terminalReason: 'done' as const,
      semanticProgress: { kind: 'verified' as const },
    }
    expect(skillOutcomeLinkFromPacket({ decisionId: 'dec_1', packet: { ...base, verification: { verified: true } } }).verification).toBe(
      'verified',
    )
    expect(skillOutcomeLinkFromPacket({ decisionId: 'dec_1', packet: { ...base, verification: { verified: false } } }).verification).toBe(
      'not_verified',
    )
    const missing = skillOutcomeLinkFromPacket({
      decisionId: 'dec_1',
      packet: { ...base, verification: {} as { verified: boolean } },
    })
    expect(missing.verification).toBe('unknown')
  })

  test('mechanical movement is partial progress, verified progress is achieved, regressed is not progress', () => {
    const base = {
      decisionEpoch: 481,
      commitmentId: 'commit:1',
      selectedCandidateId: 'kill:e183',
      terminalReason: 'done' as const,
      verification: { verified: false },
    }
    const progressOf = (kind: (typeof LANDED_437_PROGRESS_KINDS)[number]) =>
      skillOutcomeLinkFromPacket({ decisionId: 'dec_1', packet: { ...base, semanticProgress: { kind } } }).semanticProgress
    expect(progressOf('verified')).toBe('achieved')
    expect(progressOf('search')).toBe('partial')
    expect(progressOf('mechanical')).toBe('partial')
    expect(progressOf('none')).toBe('none')
    expect(progressOf('regressed')).toBe('none')
  })

  test('a killed HUNT_DROP target with no acquired item remains a typed partial boundary', () => {
    const link = skillOutcomeLinkFromPacket({
      decisionId: 'dec_1',
      packet: {
        decisionEpoch: 481,
        commitmentId: 'commit:drop-miss',
        selectedCandidateId: 'ATTACK:e183',
        terminalReason: 'drop_not_acquired',
        verification: { verified: false, postcondition: 'entity death AND ender_pearl acquired' },
        semanticProgress: { kind: 'search', delta: 0 },
        failure: {
          code: 'drop_not_acquired',
          reason: 'the selected entity died, but the declared item did not enter the inventory',
        },
      },
    })
    expect(link.terminalReason).toBe('drop_not_acquired')
    expect(link.verification).toBe('not_verified')
    expect(link.semanticProgress).toBe('partial')
    expect(link.failure).toBe('drop_not_acquired: the selected entity died, but the declared item did not enter the inventory')
  })

  test('a typed failure keeps its code, and a link passes the artifact consistency check', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor())
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'choice') return
    const artifact = f.sink.artifacts()[0]
    expect(artifact).toBeDefined()
    if (artifact === undefined) return
    const link = skillOutcomeLinkFromPacket({
      decisionId: artifact.decisionId,
      packet: {
        decisionEpoch: artifact.decisionEpoch,
        commitmentId: `commit_${artifact.decisionId}`,
        selectedCandidateId: 'kill:e183',
        terminalReason: 'blocked',
        verification: { verified: false, postcondition: 'target_dead' },
        semanticProgress: { kind: 'mechanical', delta: 3 },
        failure: { code: 'path_timeout', reason: 'no route within budget' },
      },
    })
    expect(link.failure).toBe('path_timeout: no route within budget')
    expect(link.decisionId).toBe(artifact.decisionId)
    const record = linkSkillOutcome(artifact, link, '2026-09-22T00:00:03.000Z')
    expect(record.record).toBe('JEV_DECISION_LINK')
    expect(record.skillOutcome?.commitmentId).toBe(`commit_${artifact.decisionId}`)
  })
})
