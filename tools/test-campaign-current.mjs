import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { archiveCampaignHistory, buildCampaignCurrent, campaignRunnerMatches, captureCampaignCurrent, inspectCampaignProcess } from './campaign-current.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runnerRegistry = { runId: 'portal-test', runDir: join(root, 'runs/capability-campaign/runs/portal-test'), port: 26614, sha: 'new-generation', hostBootSha: 'boot' }
const runnerArgv = ['bun', join(root, 'tools/capability-run.mjs'), '--sha', 'boot', '--run-id', 'portal-test', '--port', '26614']
assert.equal(campaignRunnerMatches(runnerArgv, runnerRegistry), true, 'standard launcher owns the exact run without a runDir argv')
assert.equal(campaignRunnerMatches(runnerArgv, { ...runnerRegistry, hostBootSha: undefined, sha: 'boot' }), true, 'claiming registry binds launch SHA')
assert.equal(campaignRunnerMatches(runnerArgv, { ...runnerRegistry, runId: 'other-run' }), false)
assert.equal(campaignRunnerMatches(runnerArgv, { ...runnerRegistry, port: 26615 }), false)
assert.equal(campaignRunnerMatches(runnerArgv, { ...runnerRegistry, hostBootSha: 'other-boot' }), false)
assert.equal(campaignRunnerMatches(['python3', join(runnerRegistry.runDir, 'minors/p1.1/resume/resume-stack.py')], runnerRegistry), true)
assert.equal(campaignRunnerMatches(['node', 'unrelated.mjs', runnerRegistry.runDir], runnerRegistry), false, 'an unrelated process mentioning the run path does not own it')
assert.equal(campaignRunnerMatches(runnerArgv, { ...runnerRegistry, runDir: '/unrelated' }), false)

const at = '2026-10-06T09:00:00.000Z'
const registry = {
  status: 'active', runId: 'portal-test', activeMinor: 'portal-test.3', internalRunId: 'run-test',
  port: 26614, runtimeDir: '/campaign/src/packages/buddy-driver', runDir: '/campaign',
  residentPid: 100, hostBootSha: 'host-sha', generationSourceSha: 'old-sha',
  generationBuildHash: 'old-hash', activeGenerationId: 'gen-old', policyProfile: 'free-profile', policyModel: 'free-model',
}
const processes = { resident: { pid: 100, alive: true, identityMatches: true } }
const report = {
  connected: true, frozen: false, runId: 'run-test', generationId: 'gen-new',
  worldKey: { serverId: '127.0.0.1:26614', dimension: 'minecraft:overworld', worldEpoch: 1 },
  currentInventoryObservation: { sourceSha: 'host-sha', observedAt: at },
  status: { running: true, sourceSha: 'live-sha', buildHash: 'live-hash', treeDirty: false,
    policyProfile: 'free-profile', policyModel: 'free-model', policyProvider: 'provider',
    truth: { inventory: { raw_iron: 9 }, health: 18, food: 17 }, queue: { current: { id: 'smelt', kind: 'smelt' } } },
}
const state = { activeRun: 'obsolete-run', activePortalMinor: 'obsolete-minor', liveProvenance: { status: 'quiesced-audit' },
  missionScoreboard: { highWater: 'iron pickaxe', current: 'stale current field', deathsSinceLastDelta: 3, verifiedNetherEntry: false } }
const input = { registry, state, report, processes, generatedAt: at, mainSha: 'main-sha', deaths: 4 }
const before = JSON.stringify(input)
const current = buildCampaignCurrent(input)
assert.equal(current.campaign.runId, 'portal-test')
assert.equal(current.source.generationSourceSha, 'live-sha', 'live source wins over durable source')
assert.equal(current.source.hostBootSha, 'host-sha', 'HOST boot stays separate from generation source')
assert.deepEqual(current.lifecycle.drift, ['generationId', 'generationSourceSha', 'generationBuildHash'])
assert.equal(current.lifecycle.evidence, 'UNKNOWN_PROVENANCE_DRIFT')
assert.deepEqual(current.liveTruth.inventory, { raw_iron: 9 })
assert.equal(current.next.conversionCheckpointRequired, true)
assert.equal(current.missionHistory.attemptDeathsObserved, 4)
assert.equal(JSON.stringify(input), before, 'projection cannot repair or mutate its owners')
assert.deepEqual(buildCampaignCurrent(input), current, 'deterministic fixture projection')
assert.ok(JSON.stringify(current).length < 6000)
assert.equal(current.derivedOnly, true)

const matched = { ...registry, activeGenerationId: 'gen-new', generationSourceSha: 'live-sha', generationBuildHash: 'live-hash' }
assert.equal(buildCampaignCurrent({ ...input, registry: matched }).lifecycle.evidence, 'LIVE')

const frozenRegistry = { ...registry, lifecycle: 'frozen', activeGenerationId: null }
const frozenReport = {
  ...report, frozen: true, generationId: null, status: null,
  currentInventoryObservation: {
    sourceSha: 'host-sha', generationId: null, observedAt: at,
    worldKey: report.worldKey, counts: { iron_ingot: 1 },
  },
}
const frozenCurrent = buildCampaignCurrent({ ...input, registry: frozenRegistry, report: frozenReport })
assert.equal(frozenCurrent.lifecycle.evidence, 'FROZEN', 'native frozen report is current even with no active generation')
assert.equal(frozenCurrent.lifecycle.frozen, true)
assert.equal(frozenCurrent.lifecycle.connected, true)
assert.equal(frozenCurrent.lifecycle.recordedLifecycle, 'frozen', 'registry lifecycle is distinct from registry status')
assert.equal(frozenCurrent.source.generationId, null, 'disposed generation is never projected as active')
assert.equal(frozenCurrent.source.generationSourceSha, null)
assert.equal(frozenCurrent.source.hostBootSha, 'host-sha', 'frozen report preserves the native HOST boot source')
assert.deepEqual(frozenCurrent.liveTruth.inventory, { iron_ingot: 1 })
const frozenDrift = buildCampaignCurrent({
  ...input,
  registry: { ...frozenRegistry, activeGenerationId: 'gen-disposed', hostBootSha: 'wrong-boot', lifecycle: 'active' },
  report: frozenReport,
})
assert.equal(frozenDrift.lifecycle.evidence, 'UNKNOWN_PROVENANCE_DRIFT')
assert.equal(frozenDrift.lifecycle.frozen, true, 'native quiesced truth remains visible while registry drift is flagged')
assert.deepEqual(frozenDrift.lifecycle.drift, ['activeGenerationId', 'hostBootSha', 'lifecycle'])
for (const variant of [
  { registry: { ...registry, status: 'quiesced' } },
  { processes: { resident: { alive: false, identityMatches: false } } },
  { processes: { resident: { alive: true, identityMatches: false } } },
  { report: null },
  { registry: null },
  { generatedAt: '2026-10-06T09:02:00.000Z' },
]) {
  const inactive = buildCampaignCurrent({ ...input, ...variant })
  assert.equal(inactive.liveTruth, null, 'inactive, recycled PID or stale report cannot become current truth')
  assert.equal(inactive.serving, null)
  assert.equal(inactive.source.generationId, null)
  assert.notEqual(inactive.lifecycle.evidence, 'LIVE')
}
assert.equal(inspectCampaignProcess(process.pid, 'resident', registry).identityMatches, false, 'unrelated live process cannot own the resident')

const dir = mkdtempSync(join(tmpdir(), 'campaign-current-'))
try {
  const content = { 'P-SERIES.md': '# Immutable history\nα\n', 'state.json': JSON.stringify(state), 'STATUS.md': '# Old p12 status\nNever current\n' }
  for (const [name, bytes] of Object.entries(content)) writeFileSync(join(dir, name), bytes)
  writeFileSync(join(dir, 'active-run.json'), JSON.stringify(matched))
  const captured = await captureCampaignCurrent({ campaignDir: dir, mainSha: 'main-sha', generatedAt: at,
    probe: (_pid, role) => role === 'resident' ? processes.resident : { alive: false, identityMatches: false },
    readReport: async (socket, ms) => { assert.equal(socket, '/campaign/src/packages/buddy-driver/data/resident/control.sock'); assert.equal(ms, 2000); return { data: report } },
  })
  assert.equal(captured.lifecycle.evidence, 'LIVE')
  const sealed = archiveCampaignHistory(dir, 'audit-1')
  for (const file of sealed.files) {
    const bytes = readFileSync(join(sealed.archiveDir, file.name))
    assert.equal(bytes.toString(), content[file.name], 'history preserved byte-for-byte')
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256)
  }
  assert.equal(readFileSync(join(dir, 'P-SERIES.md'), 'utf8'), content['P-SERIES.md'])
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), content['state.json'])
  assert.match(readFileSync(join(dir, 'STATUS.md'), 'utf8'), /legacy \/ non-authoritative/)
  assert.throws(() => archiveCampaignHistory(dir, 'audit-1'), /never overwrite/)
  assert.throws(() => archiveCampaignHistory(dir, '../escape'), /invalid archive label/)
} finally { rmSync(dir, { recursive: true, force: true }) }
console.log('campaign-current: live precedence, source/HOST separation, freshness, inactive safety and lossless immutable history PASS')
