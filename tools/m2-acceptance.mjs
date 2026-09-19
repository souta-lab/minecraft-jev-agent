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
// MILESTONES.md's diamond-pickaxe terminal and the earlier #209 extension are
// HISTORICAL/spec drift and MUST NOT gate M2. The diamond-pickaxe criterion
// belongs to the SEPARATE M3 acceptance defined below (`M3_CRITERIA` /
// `runM3Acceptance`, CLI `--m3`) and is never consulted by the M2 pass/fail
// path, so M2 and M3 cannot drift back into each other.
import { existsSync } from 'node:fs'
import net from 'node:net'
import { pathToFileURL } from 'node:url'

export const SOCK_PATH =
  process.env.M2_CONTROL_SOCK ?? '/home/s0u7a/mc-ai/buddy-driver/data/resident/control.sock'
export const RUN_ID_RE = /^run-[A-Za-z0-9-]+$/
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
} = {}) {
  const ts = now().toISOString()
  write(`${label} acceptance check — ${ts}`)
  write(`socket : ${sockPath}`)
  write(`command: ${JSON.stringify(REPORT_COMMAND)}`)
  write(`expectedRunId: ${expectedRunId ?? 'none'}`)

  const reportReply = await request(REPORT_COMMAND.cmd)
  const reportData = unwrapReply(reportReply)
  let data = reportData
  let inventory = extractInventory(data)
  if (reportReply !== null && inventory === null) {
    const statusData = unwrapReply(await request('status'))
    if (statusData !== null && typeof statusData === 'object') data = statusData
    inventory = extractInventory(data)
  }

  if (data === null || typeof data !== 'object' || inventory === null) {
    write('live: unavailable')
    write('RESULT: UNKNOWN (no fabricated values)')
    return 2
  }

  const observedRunId =
    typeof reportData?.runId === 'string'
      ? reportData.runId
      : typeof data?.runId === 'string'
        ? data.runId
        : null
  write(`runId: ${observedRunId ?? 'unknown'}`)
  if (expectedRunId !== null && observedRunId !== expectedRunId) {
    write(`RESULT: UNKNOWN (run scope mismatch expected=${expectedRunId} observed=${observedRunId ?? 'unknown'})`)
    return 2
  }

  // Printed only after a readable snapshot with a validated run scope: the
  // chain claim is never made for unavailable or out-of-scope evidence.
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
  write(`RESULT: ${allPass ? 'PASS' : 'FAIL'}`)
  return allPass ? 0 : 1
}

/**
 * Independent M3 acceptance: owns the diamond-pickaxe criterion moved out of M2.
 * Delegates to the shared runner with the M3 criteria/chain; the M2 pass/fail
 * path above never references it.
 */
export function runM3Acceptance(options = {}) {
  return runAcceptance({ ...options, label: 'M3', criteria: M3_CRITERIA, chain: M3_CAUSAL_CHAIN })
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
  const useM3 = process.argv.slice(2).includes('--m3')
  const code = useM3 ? await runM3Acceptance({ expectedRunId }) : await runAcceptance({ expectedRunId })
  process.exit(code)
}
