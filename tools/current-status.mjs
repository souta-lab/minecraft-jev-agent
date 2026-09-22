#!/usr/bin/env bun
// current-status: derive a CURRENT-STATUS.md snapshot from real evidence only.
// Usage: bun tools/current-status.mjs [--write] [--runtime-root <tree>]
//   --write         write CURRENT-STATUS.md to the current working directory.
//   --runtime-root  inspect a resident rooted in another worktree.
// Every section is labeled EVIDENCE or UNKNOWN. Values are never invented: if a
// command fails, the section is UNKNOWN and the failure is shown verbatim.
// The command runner and the resident reader are injectable for offline tests.
import { execFile } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_RUNTIME_ROOT = CODE_ROOT
export const RESIDENT_SOCKET = join(CODE_ROOT, 'buddy-driver', 'data', 'resident', 'control.sock')
export const RESIDENT_TIMEOUT_MS = 2000

/**
 * Resolve the resident control plane explicitly. Code and runtime roots are
 * independent: a status tool checked out in one worktree must not silently
 * read another worktree's resident state.
 */
export function resolveResidentSocket({ runtimeRoot = DEFAULT_RUNTIME_ROOT, residentSocket = null } = {}) {
  if (typeof residentSocket === 'string' && residentSocket.length > 0) return resolve(residentSocket)
  if (typeof runtimeRoot !== 'string' || runtimeRoot.length === 0) return RESIDENT_SOCKET
  return join(resolve(runtimeRoot), 'buddy-driver', 'data', 'resident', 'control.sock')
}

export function formatCommand(command, args = []) {
  return [command, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ')
}

// Default runner: returns { ok, code, stdout, stderr } and never throws.
export function runCommand(command, args = []) {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolvePromise({
            ok: false,
            code: typeof error.code === 'number' ? error.code : 1,
            stdout: stdout ?? '',
            stderr: stderr ?? String(error.message ?? error),
          })
          return
        }
        resolvePromise({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
      },
    )
  })
}

// Reads exactly one JSON line from the resident control socket, 2s timeout.
// Returns the parsed object, or null when unavailable/invalid.
export function readResidentReport(socketPath = RESIDENT_SOCKET, timeoutMs = RESIDENT_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    if (!existsSync(socketPath)) {
      resolvePromise(null)
      return
    }
    const socket = net.createConnection(socketPath)
    let buffer = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        // ignore teardown errors
      }
      resolvePromise(value)
    }
    const consume = () => {
      const newline = buffer.indexOf('\n')
      if (newline === -1) return false
      try {
        finish(JSON.parse(buffer.slice(0, newline)))
      } catch {
        finish(null)
      }
      return true
    }
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.on('error', () => finish(null))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      consume()
    })
    socket.on('end', () => {
      if (!consume()) finish(null)
    })
    socket.on('connect', () => socket.write(`${JSON.stringify({ cmd: 'report' })}\n`))
  })
}

function parseJsonArray(result) {
  if (!result.ok) {
    const reason = (result.stderr || `exit code ${result.code}`).trim()
    return { ok: false, error: reason || 'command failed' }
  }
  try {
    const value = JSON.parse(result.stdout)
    if (!Array.isArray(value)) return { ok: false, error: 'unexpected JSON shape (not an array)' }
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error.message}` }
  }
}

function isP0(name) {
  return /(^|[^a-z0-9])p0([^a-z0-9]|$)/i.test(name)
}

function isP1(name) {
  return /(^|[^a-z0-9])p1([^a-z0-9]|$)/i.test(name)
}

function labelNames(issue) {
  if (!Array.isArray(issue.labels)) return []
  return issue.labels
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((name) => typeof name === 'string' && name.length > 0)
}

export async function deriveStatus(options = {}) {
  const run = options.run ?? runCommand
  const residentReader = options.readResident === false ? null : (options.readResident ?? readResidentReport)
  const residentSocket = resolveResidentSocket(options)
  const commands = []
  const trackedRun = async (command, args = []) => {
    commands.push(formatCommand(command, args))
    return run(command, args)
  }
  const sections = []

  const lines = []
  lines.push('# Current Status')
  lines.push('')
  lines.push('Generated from real evidence only. Every section is labeled EVIDENCE or UNKNOWN; no value is invented.')
  lines.push('')

  const section = (title, status, bodyLines) => {
    sections.push({ title, status })
    lines.push(`## ${title} — ${status}`)
    lines.push(...bodyLines)
    lines.push('')
  }

  const baseArgs = ['log', '-1', '--format=%H%n%s%n%cI', 'origin/main']
  const baseResult = await trackedRun('git', baseArgs)
  if (baseResult.ok && baseResult.stdout.trim()) {
    const [sha = '', subject = '', date = ''] = baseResult.stdout.trim().split('\n')
    section('Base commit (origin/main)', 'EVIDENCE', [
      `- sha: \`${sha}\``,
      `- subject: ${subject || 'UNKNOWN'}`,
      `- date: ${date || 'UNKNOWN'}`,
    ])
  } else {
    const reason = (baseResult.stderr || `exit code ${baseResult.code}`).trim() || 'command failed'
    section('Base commit (origin/main)', 'UNKNOWN', [`- UNKNOWN: ${reason}`])
  }

  // `gh` truncates to 30 by default; without an explicit limit the derived status
  // silently reports a partial repo. Always request the full set.
  const prResult = await trackedRun('gh', ['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,headRefName'])
  const prs = parseJsonArray(prResult)
  if (prs.ok) {
    const body = [`- count: ${prs.value.length}`]
    for (const pr of prs.value) {
      body.push(`- #${pr.number} ${pr.title ?? 'UNKNOWN'} (head: ${pr.headRefName ?? 'UNKNOWN'})`)
    }
    if (prs.value.length === 0) body.push('- no open pull requests')
    section('Open pull requests', 'EVIDENCE', body)
  } else {
    section('Open pull requests', 'UNKNOWN', [`- UNKNOWN: ${prs.error}`])
  }

  const issueResult = await trackedRun('gh', ['issue', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,labels'])
  const issues = parseJsonArray(issueResult)
  if (issues.ok) {
    let p0 = 0
    let p1 = 0
    let labeled = 0
    let fromTitle = 0
    const body = [`- count: ${issues.value.length}`]
    const detail = []
    for (const issue of issues.value) {
      const names = labelNames(issue)
      if (names.length > 0) labeled += 1
      const title = typeof issue.title === 'string' ? issue.title : ''
      // Labels are the primary source. Most issues in this repo carry no labels at
      // all, so fall back to the conventional `P0:` / `P1:` title prefix — otherwise
      // the status reports P1: 0 while titled P1 issues exist.
      const labelledP0 = names.some(isP0)
      const labelledP1 = names.some(isP1)
      const titledP0 = isP0(title)
      const titledP1 = isP1(title)
      if (labelledP0 || titledP0) p0 += 1
      if (labelledP1 || titledP1) p1 += 1
      if (!labelledP0 && !labelledP1 && (titledP0 || titledP1)) fromTitle += 1
      const labelText = names.length > 0 ? names.join(', ') : 'no labels'
      detail.push(`- #${issue.number} ${issue.title ?? 'UNKNOWN'} — ${labelText}`)
    }
    body.push(`- P0: ${p0}`)
    body.push(`- P1: ${p1}`)
    body.push(`- priority source: labels first, then title prefix (${fromTitle} counted from title only)`)
    body.push(`- labels: ${labeled === 0 ? 'no labels' : `${labeled} of ${issues.value.length} issues labeled`}`)
    body.push(...detail)
    if (issues.value.length === 0) body.push('- no open issues')
    section('Open issues', 'EVIDENCE', body)
  } else {
    section('Open issues', 'UNKNOWN', [`- UNKNOWN: ${issues.error}`])
  }

  if (residentReader) {
    commands.push(`socket ${residentSocket} <- {"cmd":"report"} (${RESIDENT_TIMEOUT_MS}ms timeout)`)
    let report = null
    try {
      report = await residentReader(residentSocket)
    } catch {
      report = null
    }
    if (report === null || report === undefined) {
      section('Resident snapshot', 'UNKNOWN', ['live: unavailable'])
    } else {
      section('Resident snapshot', 'EVIDENCE', [
        'live: report received',
        '```json',
        JSON.stringify(report, null, 2),
        '```',
      ])
    }
  }

  section('Evidence commands', 'EVIDENCE', commands.map((command) => `- \`${command}\``))

  return { markdown: `${lines.join('\n').replace(/\n+$/, '')}\n`, commands, sections }
}

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? null : argv[index + 1] ?? null
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const runtimeRoot = options.runtimeRoot ?? optionValue(argv, '--runtime-root')
  const residentSocket = options.residentSocket ?? optionValue(argv, '--resident-socket')
  const statusOptions = {
    ...options,
    ...(runtimeRoot === null ? {} : { runtimeRoot }),
    ...(residentSocket === null ? {} : { residentSocket }),
  }
  const { markdown } = await deriveStatus(statusOptions)
  let written = null
  if (argv.includes('--write')) {
    written = join(cwd, 'CURRENT-STATUS.md')
    writeFileSync(written, markdown)
  }
  return { markdown, written }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const { markdown, written } = await main()
  process.stdout.write(markdown)
  if (written) process.stderr.write(`wrote ${written}\n`)
}
