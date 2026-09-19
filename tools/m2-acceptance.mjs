#!/usr/bin/env node
// m2-acceptance: read-only M2/M3 exit-criteria check against the live resident
// control socket. Prints PASS/FAIL per criterion with observed numbers.
// Exit 0 = PASS, 1 = FAIL, 2 = socket/scope unreadable (never fabricates a value).
//
// M2 CONTRACT (authoritative, this is the single source of truth):
//   charcoal >= 1 / iron_ingot >= 3 / iron_pickaxe >= 1
// joined within ONE resident run by the ordered causal chain
//   PREREQ_OPTION -> FURNACE_READY -> SMELT_DONE
// (the log chain itself is enforced by m2-watch / m2-live-gate for the same run).
// A single snapshot cannot prove ordering by itself, so the within-run rule is
// enforced by the exact runId join: `--run <runId>` (or M2_RUN_ID) must match
// the resident runId. Transient rungs (logs, planks, crafting table,
// wooden/stone tools, raw ore) are consumed before the final snapshot.
//
// Inventory evidence has TWO documented sources, reported on the `evidence:`
// line:
//   1. `live-socket`         - the resident answers the control socket for the
//                              SAME runId with a complete terminal inventory.
//   2. `run-scoped-snapshot` - the resident's own `m2-snapshot-<runId>.json`,
//                              written from live bot state when each marker and
//                              the verified terminal craft fired. It is used
//                              after exit and also when a same-run live socket
//                              has consumed transient evidence.
// The snapshot is only accepted when ALL hold, else UNKNOWN (never PASS):
//   - `snapshot.runId === --run`;
//   - the recorded `buildHash` / `bootSourceSha` equal that run's BUILD `hash`
//     and BOOT `source` (read from the log; `--log` overrides the default);
//   - the recorded ordered chain PREREQ_OPTION -> FURNACE_READY -> SMELT_DONE
//     is VALID (the same chain m2-watch enforces);
//   - charcoal is observed at FURNACE_READY, iron_ingot at SMELT_DONE, and a
//     verified post-chain iron-pickaxe craft or terminal inventory is present.
// REAL-POLICY REQUIREMENT (gate strengthening, NOT a substitute marker):
//   the same run R must ALSO show that the real policy actually ran, otherwise
//   RESULT is UNKNOWN and M2 can never PASS. Two run-bound facts are required:
//     - >= 1 decision in R's window with source=jev
//       (buddy-driver/logs/jev/decisions.jsonl), and
//     - R's generation reports policyKind=typesafe / policyModel=typesafe-ai/jev
//       (socket `report.status`, or the GENERATION_READY line in runner.out).
//   See tools/m2-policy-evidence.mjs. A deterministic fallback run (source=
//   fallback / policyKind=fallback) is UNKNOWN, never PASS. A known inventory
//   failure still returns FAIL unless the same run has a valid bound snapshot
//   proving the earlier transient facts, matching the live gate's FAIL>UNKNOWN
//   rule after all same-run evidence is joined.
//
// MILESTONES.md's diamond-pickaxe terminal and the earlier #209 extension are
// HISTORICAL/spec drift and MUST NOT gate M2. The diamond-pickaxe criterion
// belongs to the SEPARATE M3 acceptance defined below (`M3_CRITERIA` /
// `runM3Acceptance`, CLI `--m3`) and is never consulted by the M2 pass/fail
// path, so M2 and M3 cannot drift back into each other.
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { pathToFileURL } from 'node:url'
import { evaluatePolicyEvidence, loadPolicyEvidence } from './m2-policy-evidence.mjs'

export const SOCK_PATH =
  process.env.M2_CONTROL_SOCK ?? '/home/s0u7a/mc-ai/buddy-driver/data/resident/control.sock'
export const RUN_ID_RE = /^run-[A-Za-z0-9-]+$/
/**
 * Run-scoped evidence the RESIDENT writes at marker time. A snapshot for one run
 * can never satisfy another: both the filename and the body's `runId` are bound,
 * and the recorded build/source must match the run's BOOT/BUILD records.
 */
export const M2_SNAPSHOT_DIR =
  process.env.M2_SNAPSHOT_DIR ?? '/home/s0u7a/mc-ai/buddy-driver/data/resident'
export const M2_LOG_PATH =
  process.env.M2_LOG ?? process.env.BUDDY_LOG ?? '/home/s0u7a/mc-ai/buddy-driver/buddy.log'
export const M2_SNAPSHOT_RECORD = 'm2-snapshot'
export const M2_REQUIRED_MARKERS = Object.freeze(['PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE'])

export const EVIDENCE_SOURCES = Object.freeze(['live-socket', 'run-scoped-snapshot'])
/**
 * Resident report can briefly queue behind a generation boundary. Three
 * seconds produced false UNKNOWN results during an otherwise healthy socket
 * session, which weakened the M2 FAIL-vs-UNKNOWN evidence distinction.
 */
export const M2_CONTROL_TIMEOUT_MS = 10_000

/**
 * The M2 acceptance contract, exactly as ruled: charcoal, iron_ingot and
 * iron_pickaxe. Each rung's `requires` names the rung that must already have
 * happened in the same run. This is the single source of the M2 criteria;
 * `diamond_pickaxe` is deliberately absent (it lives in M3_CRITERIA below).
 */
export const M2_CRITERIA = [
  { item: 'charcoal', need: 1, requires: null },
  { item: 'iron_ingot', need: 3, requires: 'charcoal' },
  { item: 'iron_pickaxe', need: 1, requires: 'iron_ingot' },
]

/** Ordered item names of M2_CRITERIA, printed so the required order is explicit in gate output. */
export const M2_CAUSAL_CHAIN = Object.freeze(M2_CRITERIA.map(({ item }) => item))

/**
 * Separate M3 acceptance: owns the diamond-pickaxe terminal that used to be
 * (incorrectly) part of M2. Exported and independently runnable via
 * `runM3Acceptance` / CLI `--m3`. It is NOT consulted by the M2 pass/fail path,
 * so the two contracts can never drift back into each other.
 */
export const M3_CRITERIA = [{ item: 'diamond_pickaxe', need: 1, requires: 'iron_pickaxe' }]

/** Ordered item names of M3_CRITERIA, printed so the required order is explicit in gate output. */
export const M3_CAUSAL_CHAIN = Object.freeze(M3_CRITERIA.map(({ item }) => item))

export const REPORT_COMMAND = { id: 'm2', cmd: 'report' }

export function makeControl(sockPath, { timeoutMs = M2_CONTROL_TIMEOUT_MS } = {}) {
  return function request(cmd) {
    return new Promise((resolve) => {
      if (!existsSync(sockPath)) return resolve(null)
      let settled = false
      let buf = ''
      let sock
      const finish = (value) => {
        if (settled) return
        settled = true
        try {
          sock?.destroy()
        } catch {}
        resolve(value)
      }
      try {
        sock = net.createConnection(sockPath)
      } catch {
        return finish(null)
      }
      sock.setTimeout(timeoutMs, () => finish(null))
      sock.on('error', () => finish(null))
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        const nl = buf.indexOf('\n')
        if (nl === -1) return
        try {
          finish(JSON.parse(buf.slice(0, nl)))
        } catch {
          finish(null)
        }
      })
      sock.on('connect', () => sock.write(`${JSON.stringify({ id: 'm2', cmd })}\n`))
    })
  }
}

export function unwrapReply(reply) {
  if (
    reply !== null &&
    typeof reply === 'object' &&
    reply.data !== null &&
    typeof reply.data === 'object' &&
    ('ok' in reply || 'id' in reply)
  ) {
    return reply.data
  }
  return reply
}

export function extractInventory(data) {
  const candidates = [data?.status?.truth?.inventory, data?.truth?.inventory, data?.inventory]
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate
  }
  return null
}

export function observedCount(inventory, item) {
  const value = inventory[item]
  return Number.isFinite(value) ? value : 0
}

/** Pure criterion evaluation shared by the M2 and M3 acceptance paths. */
export function evaluateCriteria(criteria, inventory) {
  const observed = {}
  let allPass = true
  for (const { item, need } of criteria) {
    const got = observedCount(inventory, item)
    observed[item] = got
    if (got < need) allPass = false
  }
  return { allPass, observed }
}

export function snapshotPathFor(runId, dir = M2_SNAPSHOT_DIR) {
  return `${dir}/m2-snapshot-${runId}.json`
}

export function readSnapshotFile(runId, dir = M2_SNAPSHOT_DIR) {
  const path = snapshotPathFor(runId, dir)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (parsed.record !== M2_SNAPSHOT_RECORD) return null
    if (typeof parsed.runId !== 'string' || parsed.runId !== runId) return null
    return parsed
  } catch {
    return null
  }
}

/** Same ordered-subsequence rule as m2-watch deriveFrontier. */
export function orderedRequiredChain(sequence) {
  const observed = []
  let cursor = 0
  for (const marker of Array.isArray(sequence) ? sequence : []) {
    const want = M2_REQUIRED_MARKERS[cursor]
    if (want === undefined) break
    if (marker !== want) continue
    observed.push(marker)
    cursor += 1
  }
  return { valid: cursor === M2_REQUIRED_MARKERS.length, observed }
}

function snapshotHasOrderedChain(snapshot) {
  const sequence = Array.isArray(snapshot?.sequence)
    ? snapshot.sequence
    : Array.isArray(snapshot?.markers)
      ? snapshot.markers.map((marker) => marker?.name)
      : []
  const { valid, observed } = orderedRequiredChain(sequence)
  if (!valid) return { valid, observed }
  return { valid: snapshot?.chain?.status === 'VALID', observed }
}

function snapshotInventory(snapshot) {
  const inventory = snapshot?.inventory
  if (inventory === null || typeof inventory !== 'object' || Array.isArray(inventory)) return null
  return inventory
}

function snapshotMarker(snapshot, name) {
  if (!Array.isArray(snapshot?.markers)) return null
  const marker = snapshot.markers.find((entry) => entry?.name === name)
  if (marker === undefined || marker === null || typeof marker !== 'object') return null
  if (!Number.isFinite(marker.atMs) || marker.inventory === null || typeof marker.inventory !== 'object' || Array.isArray(marker.inventory)) return null
  return marker
}

/**
 * Resolve the three M2 inventory facts from the observations that actually
 * prove them. Charcoal is transient and belongs to FURNACE_READY; iron_ingot
 * is transient and belongs to SMELT_DONE. A verified post-chain craft terminal
 * supplies iron_pickaxe when present; legacy snapshots may use their latest
 * inventory for that durable fact. The ordered marker timestamps are checked so
 * a malformed snapshot cannot combine unrelated occurrences.
 */
export function snapshotEvidenceInventory(snapshot) {
  const chain = snapshotHasOrderedChain(snapshot)
  if (!chain.valid) return null
  const furnace = snapshotMarker(snapshot, 'FURNACE_READY')
  const smelt = snapshotMarker(snapshot, 'SMELT_DONE')
  if (furnace === null || smelt === null) return null
  const prereq = snapshotMarker(snapshot, 'PREREQ_OPTION')
  if (prereq === null || prereq.atMs > furnace.atMs || furnace.atMs > smelt.atMs) return null
  const latestInventory = snapshotInventory(snapshot)
  if (latestInventory === null) return null

  let terminalInventory = latestInventory
  if (snapshot.terminal !== undefined && snapshot.terminal !== null) {
    const terminal = snapshot.terminal
    if (
      terminal.actionId !== 'CRAFT:iron_pickaxe' ||
      terminal.verified !== true ||
      terminal.status !== 'done' ||
      !Number.isFinite(terminal.atMs) ||
      terminal.atMs < smelt.atMs ||
      terminal.inventory === null ||
      typeof terminal.inventory !== 'object' ||
      Array.isArray(terminal.inventory)
    ) return null
    terminalInventory = terminal.inventory
  }

  return {
    inventory: {
      ...latestInventory,
      charcoal: observedCount(furnace.inventory, 'charcoal'),
      iron_ingot: observedCount(smelt.inventory, 'iron_ingot'),
      iron_pickaxe: observedCount(terminalInventory, 'iron_pickaxe'),
    },
    source: snapshot.terminal === null || snapshot.terminal === undefined ? 'marker-plus-latest' : 'marker-plus-terminal',
  }
}

/** BOOT `source=` + the following BUILD `hash=` for one run, from the resident log. */
export function readRunIdentityFromLog(runId, logPath = M2_LOG_PATH) {
  if (!existsSync(logPath)) return null
  let lines
  try {
    lines = readFileSync(logPath, 'utf8').split('\n')
  } catch {
    return null
  }
  let bootSourceSha = null
  let buildHash = null
  let inRun = false
  for (const line of lines) {
    if (/\bBOOT\b(?!_)/.test(line)) {
      const lineRunId = /\brunId=(run-[A-Za-z0-9-]+)/.exec(line)?.[1] ?? null
      if (lineRunId !== runId) {
        if (inRun) break
        continue
      }
      inRun = true
      bootSourceSha = /\bsource=([^\s]+)/.exec(line)?.[1] ?? null
      continue
    }
    if (!inRun) continue
    const build = /\bBUILD\b[^\n]*\bhash=([^\s]+)/.exec(line)
    if (build) {
      buildHash = build[1]
      break
    }
  }
  if (!inRun) return null
  return { runId, bootSourceSha, buildHash }
}

export function requestedRunId(argv = process.argv.slice(2), env = process.env) {
  let value = env.M2_RUN_ID ?? null
  const index = argv.indexOf('--run')
  if (index !== -1) value = argv[index + 1] ?? null
  if (value === null || String(value).trim() === '') return null
  const runId = String(value).trim()
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid --run value: ${value}`)
  return runId
}

export async function runAcceptance({
  request = makeControl(SOCK_PATH),
  now = () => new Date(),
  write = (line) => process.stdout.write(`${line}\n`),
  sockPath = SOCK_PATH,
  expectedRunId = null,
  label = 'M2',
  criteria = M2_CRITERIA,
  chain = M2_CAUSAL_CHAIN,
  snapshotDir = M2_SNAPSHOT_DIR,
  logPath = M2_LOG_PATH,
  readSnapshot,
  readRunIdentity,
  requireRealPolicy = true,
  policyEvidence = null,
  loadPolicy = loadPolicyEvidence,
  decisionsPath,
  runnerOutPath,
} = {}) {
  const ts = now().toISOString()
  write(`${label} acceptance check — ${ts}`)
  write(`socket : ${sockPath}`)
  write(`command: ${JSON.stringify(REPORT_COMMAND)}`)
  write(`expectedRunId: ${expectedRunId ?? 'none'}`)

  const resolveSnapshot = readSnapshot ?? ((runId) => readSnapshotFile(runId, snapshotDir))
  const resolveIdentity = readRunIdentity ?? ((runId) => readRunIdentityFromLog(runId, logPath))

  const emit = async (data, reportData, inventory, boundRunId) => {
    // Printed only after a readable evidence source with a validated run scope:
    // the chain claim is never made for unavailable or out-of-scope evidence.
    write(`chain: ${chain.join(' -> ')}`)
    const { allPass, observed } = evaluateCriteria(criteria, inventory)
    for (const { item, need } of criteria) {
      write(`${observed[item] >= need ? 'PASS' : 'FAIL'} ${item} >= ${need} (observed ${observed[item]})`)
    }
    const wedge = data?.stats?.wedge ?? reportData?.stats?.wedge ?? null
    const goalComplete = data?.stats?.goalComplete ?? reportData?.stats?.goalComplete ?? null
    const milestone = data?.milestone ?? reportData?.milestone ?? null
    write(`milestone: ${milestone === null ? 'unknown' : milestone}`)
    write(`wedge: ${wedge === null ? 'unknown' : wedge}`)
    write(`goalComplete: ${goalComplete === null ? 'unknown' : goalComplete}`)
    write(`inventory: ${JSON.stringify(observed)}`)

    // Real-policy evidence is evaluated for every readable in-scope snapshot
    // so the audit trail names the sources and facts. It can only turn a
    // would-be PASS into UNKNOWN; a known inventory failure remains FAIL.
    let policyResult = null
    if (requireRealPolicy) {
      const socket = {
        runId: boundRunId,
        policyKind: data?.status?.policyKind ?? reportData?.status?.policyKind ?? null,
        policyModel: data?.status?.policyModel ?? reportData?.status?.policyModel ?? null,
      }
      let evidence = policyEvidence
      if (evidence === null || evidence === undefined) {
        evidence = await loadPolicy({ runId: boundRunId, socket, decisionsPath, runnerOutPath })
      }
      policyResult = evaluatePolicyEvidence({
        expectedRunId: boundRunId,
        decisions: evidence?.decisions ?? null,
        generation: evidence?.generation ?? null,
      })
      const f = policyResult.facts
      write(`policy: required policyKind=${f.requiredPolicyKind} policyModel=${f.requiredPolicyModel}`)
      write(
        `policy decisions: source=${f.decisionsSource ?? 'unavailable'} runId=${f.decisionsRunId ?? 'unknown'} ` +
          `source=jev count=${f.jevDecisions ?? 'unknown'} source=fallback count=${f.fallbackDecisions ?? 'unknown'}`,
      )
      write(
        `policy generation: source=${f.generationSource ?? 'unavailable'} runId=${f.generationRunId ?? 'unknown'} ` +
          `policyKind=${f.policyKind ?? 'unknown'} policyModel=${f.policyModel ?? 'unknown'}`,
      )
      write(`POLICY: ${policyResult.status} reason=${policyResult.reason}`)
    }

    if (!allPass) {
      write('RESULT: FAIL')
      return 1
    }
    if (policyResult !== null && policyResult.code !== 0) {
      write(`RESULT: UNKNOWN (real policy evidence not verified: ${policyResult.reason})`)
      return 2
    }
    write('RESULT: PASS')
    return 0
  }

  const loadBoundSnapshotEvidence = async (runId) => {
    const snapshotPath = snapshotPathFor(runId, snapshotDir)
    const snapshot = await resolveSnapshot(runId)
    if (snapshot === null) return { status: 'unavailable', snapshotPath }
    if (snapshot.runId !== runId) {
      return {
        status: 'unknown',
        snapshotPath,
        reason: `snapshot run scope mismatch expected=${runId} observed=${typeof snapshot.runId === 'string' ? snapshot.runId : 'unknown'}`,
      }
    }
    const chainCheck = snapshotHasOrderedChain(snapshot)
    if (!chainCheck.valid) {
      return {
        status: 'unknown',
        snapshotPath,
        reason: `snapshot chain incomplete expected=${M2_REQUIRED_MARKERS.join('->')} observed=${chainCheck.observed.join('->') || 'none'}`,
      }
    }
    const identity = await resolveIdentity(runId)
    if (identity === null) return { status: 'unknown', snapshotPath, reason: `run identity unreadable for ${runId}` }
    if (typeof identity.buildHash !== 'string' || snapshot.buildHash !== identity.buildHash) {
      return {
        status: 'unknown',
        snapshotPath,
        reason: `snapshot build mismatch expected=${identity.buildHash ?? 'unknown'} observed=${snapshot.buildHash ?? 'unknown'}`,
      }
    }
    if (typeof identity.bootSourceSha !== 'string' || snapshot.bootSourceSha !== identity.bootSourceSha) {
      return {
        status: 'unknown',
        snapshotPath,
        reason: `snapshot source mismatch expected=${identity.bootSourceSha ?? 'unknown'} observed=${snapshot.bootSourceSha ?? 'unknown'}`,
      }
    }
    let evidence
    if (label === 'M2') {
      evidence = snapshotEvidenceInventory(snapshot)
    } else {
      const latest = snapshotInventory(snapshot)
      evidence = latest === null ? null : { inventory: latest, source: 'latest-snapshot' }
    }
    if (evidence === null) return { status: 'unknown', snapshotPath, reason: 'snapshot inventory evidence unreadable' }
    return { status: 'valid', snapshotPath, snapshot, inventory: evidence.inventory, source: evidence.source }
  }

  const reportReply = await request(REPORT_COMMAND.cmd)
  const reportData = unwrapReply(reportReply)
  let data = reportData
  let inventory = extractInventory(data)
  if (reportReply !== null && inventory === null) {
    const statusData = unwrapReply(await request('status'))
    if (statusData !== null && typeof statusData === 'object') data = statusData
    inventory = extractInventory(data)
  }
  const observedRunId =
    typeof reportData?.runId === 'string'
      ? reportData.runId
      : typeof data?.runId === 'string'
        ? data.runId
        : null

  if (inventory !== null && (expectedRunId === null || observedRunId === expectedRunId)) {
    // A completed craft necessarily consumes transient charcoal and ingots. If
    // the same resident run has a bound snapshot proving those earlier facts,
    // consume that evidence rather than falsely failing on the terminal socket
    // inventory. A complete live inventory still keeps live-socket precedence.
    if (label === 'M2' && expectedRunId !== null && !evaluateCriteria(criteria, inventory).allPass) {
      const bound = await loadBoundSnapshotEvidence(expectedRunId)
      if (bound.status === 'valid' && evaluateCriteria(criteria, bound.inventory).allPass) {
        write('evidence: run-scoped-snapshot')
        write(`runId: ${expectedRunId}`)
        write(`snapshot: ${bound.snapshotPath}`)
        write(`snapshotInventoryEvidence: ${bound.source}`)
        return emit(data, reportData, bound.inventory, expectedRunId)
      }
    }
    write('evidence: live-socket')
    write(`runId: ${observedRunId ?? 'unknown'}`)
    return emit(data, reportData, inventory, observedRunId)
  }

  if (inventory !== null) {
    write(`runId: ${observedRunId ?? 'unknown'}`)
    write(`RESULT: UNKNOWN (run scope mismatch expected=${expectedRunId} observed=${observedRunId ?? 'unknown'})`)
    return 2
  }

  write('live: unavailable')
  if (expectedRunId === null) {
    write('RESULT: UNKNOWN (no fabricated values)')
    return 2
  }

  const bound = await loadBoundSnapshotEvidence(expectedRunId)
  if (bound.status === 'unavailable') {
    write(`snapshot: unavailable (${bound.snapshotPath})`)
    write('RESULT: UNKNOWN (no fabricated values)')
    return 2
  }
  if (bound.status === 'unknown') {
    write(`snapshot: ${bound.snapshotPath}`)
    write(`RESULT: UNKNOWN (${bound.reason})`)
    return 2
  }
  const snapshot = bound.snapshot
  write(`snapshot: ${bound.snapshotPath}`)
  write('evidence: run-scoped-snapshot')
  write(`runId: ${snapshot.runId}`)
  write(`snapshotGenerationId: ${typeof snapshot.generationId === 'string' ? snapshot.generationId : 'unknown'}`)
  write(`snapshotBuildHash: ${snapshot.buildHash}`)
  write(`snapshotBootSourceSha: ${snapshot.bootSourceSha}`)
  write(`snapshotInventoryEvidence: ${bound.source}`)
  return emit(snapshot, null, bound.inventory, expectedRunId)
}

/**
 * Independent M3 acceptance: owns the diamond-pickaxe criterion moved out of M2.
 * Delegates to the shared runner with the M3 criteria/chain; the M2 pass/fail
 * path above never references it.
 */
export function runM3Acceptance(options = {}) {
  return runAcceptance({ ...options, label: 'M3', criteria: M3_CRITERIA, chain: M3_CAUSAL_CHAIN, requireRealPolicy: false })
}

function requestedArg(name, argv = process.argv.slice(2), env = process.env, envName = null) {
  const index = argv.indexOf(name)
  if (index !== -1 && typeof argv[index + 1] === 'string') return argv[index + 1]
  if (envName !== null && typeof env[envName] === 'string' && env[envName].trim() !== '') return env[envName]
  return null
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  let expectedRunId = null
  try {
    expectedRunId = requestedRunId()
  } catch (error) {
    process.stderr.write(`M2_ACCEPTANCE status=UNKNOWN reason=${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
  const logPath = requestedArg('--log', process.argv.slice(2), process.env, 'M2_LOG') ?? M2_LOG_PATH
  const snapshotDir = requestedArg('--snapshot-dir', process.argv.slice(2), process.env, 'M2_SNAPSHOT_DIR') ?? M2_SNAPSHOT_DIR
  const useM3 = process.argv.slice(2).includes('--m3')
  const options = { expectedRunId, logPath, snapshotDir }
  const code = useM3 ? await runM3Acceptance(options) : await runAcceptance(options)
  process.exit(code)
}
