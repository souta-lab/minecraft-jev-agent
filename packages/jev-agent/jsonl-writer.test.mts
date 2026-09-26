import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'bun:test'
import { JsonlWriter } from './src/jev.ts'

test('JsonlWriter initializes an empty, hashable file without writing a record', () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-empty-jsonl-'))
  try {
    const path = join(root, 'nested', 'jev-calls.jsonl')
    const writer = new JsonlWriter(path)
    const bytes = readFileSync(path)

    expect(dirname(path)).toBe(join(root, 'nested'))
    expect(statSync(path).size).toBe(0)
    expect(bytes.length).toBe(0)
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')

    // Construction itself must not add a sentinel/metadata record.
    expect(readFileSync(path, 'utf8')).toBe('')
    expect(writer.path).toBe(path)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('JsonlWriter appends valid records after empty initialization', () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-jsonl-append-'))
  try {
    const path = join(root, 'run.jsonl')
    writeFileSync(path, `${JSON.stringify({ record: 'existing', sequence: 0 })}\n`)
    const writer = new JsonlWriter(path)
    writer.write({ record: 'probe', sequence: 1 })
    writer.write({ record: 'probe', sequence: 2 })

    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { record: 'existing', sequence: 0 },
      { record: 'probe', sequence: 1 },
      { record: 'probe', sequence: 2 },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
