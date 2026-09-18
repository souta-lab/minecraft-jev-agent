import { execFileSync } from 'node:child_process'

const repo = process.cwd()

function git(args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

let head
try {
  head = git(['symbolic-ref', '--short', 'HEAD'])
} catch {
  head = 'detached'
}

if (head !== 'main') {
  console.error(`SYNC_HEAD_WRONG head=${head}`)
  process.exitCode = 1
} else {
  try {
    git(['fetch', 'origin'])
    const target = git(['rev-parse', 'origin/main'])
    git(['reset', '--hard', 'origin/main'])
    console.log(`SYNC_OK head=main target=${target}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`SYNC_FAILED ${detail}`)
    process.exitCode = 1
  }
}
