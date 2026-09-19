#!/usr/bin/env node
// m2-acceptance: read-only terminal M2 snapshot check against the live resident
// control socket. Historical M2 progression is proved by m2-watch; this file
// deliberately checks only state that must still be true at the END of M2.
// Exit 0 = PASS, 1 = FAIL, 2 = socket/scope unreadable (never fabricates a value).
//
// MILESTONES.md defines M2 as ending in a diamond pickaxe. Earlier rungs are
// consumable evidence, NOT simultaneous inventory requirements: charcoal may be
// consumed as fuel and iron_ingot x3 is consumed to craft the iron pickaxe.
// Requiring all intermediate items in one final snapshot creates a false
// negative precisely when the agent progresses correctly. Same-run history is
// therefore owned by m2-watch; the terminal durable predicate here is simply:
//   diamond_pickaxe >= 1
import { existsSync } from 'node:fs'
import net from 'node:net'
import { pathToFileURL } from 'node:url'

export const SOCK_PATH =
  process.env.M2_CONTROL_SOCK ?? '/home/s0u7a/mc-ai/buddy-driver/data/resident/control.sock'
export const RUN_ID_RE = /^run-[A-Za-z0-9-]+$/
/** Resident reports can briefly queue behind a generation boundary. */
export const M2_CONTROL_TIMEOUT_MS = 10_000

/** Final-state predicates only. Historical rung evidence belongs to m2-watch. */
export const M2_CRITERIA = Object.freeze([{ item: 'diamond_pickaxe', need: 1 }])
export const M2_TERMINAL_ITEM = 'diamond_pickaxe'

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
} = {}) {
  const ts = now().toISOString()
  write(`M2 terminal acceptance check — ${ts}`)
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

  write('history: delegated to exact-run m2-watch (consumable intermediates are not final-snapshot gates)')
  const observed = {}
  let allPass = true
  for (const { item, need } of M2_CRITERIA) {
    const got = observedCount(inventory, item)
    observed[item] = got
    const pass = got >= need
    if (!pass) allPass = false
    write(`${pass ? 'PASS' : 'FAIL'} ${item} >= ${need} (observed ${got})`)
  }

  const wedge = data?.stats?.wedge ?? reportData?.stats?.wedge ?? null
  const goalComplete = data?.stats?.goalComplete ?? reportData?.stats?.goalComplete ?? null
  const milestone = data?.milestone ?? reportData?.milestone ?? null
  write(`milestone: ${milestone === null ? 'unknown' : milestone}`)
  write(`wedge: ${wedge === null ? 'unknown' : wedge}`)
  write(`goalComplete: ${goalComplete === null ? 'unknown' : goalComplete}`)
  write(`terminalInventory: ${JSON.stringify(observed)}`)
  write(`RESULT: ${allPass ? 'PASS' : 'FAIL'}`)
  return allPass ? 0 : 1
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
  const code = await runAcceptance({ expectedRunId })
  process.exit(code)
}
