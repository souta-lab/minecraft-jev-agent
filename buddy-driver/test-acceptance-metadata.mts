import assert from 'node:assert/strict'
import { acceptanceMetadata } from './acceptance-metadata.ts'

const complete = acceptanceMetadata(
  { version: '1.21.11', game: { difficulty: 'peaceful' } },
  { policyModel: 'typesafe-ai/jev', system2Model: 'inception/mercury-2.5' },
)
assert.deepEqual(complete, {
  serverVersion: '1.21.11',
  difficulty: 'peaceful',
  jevModel: 'typesafe-ai/jev',
  system2Model: 'inception/mercury-2.5',
})

const disconnected = acceptanceMetadata(null, null)
assert.deepEqual(disconnected, {
  serverVersion: null,
  difficulty: null,
  jevModel: null,
  system2Model: null,
})

const partial = acceptanceMetadata(
  { version: '1.21.11', game: null },
  { policyModel: 'deterministic-local-fallback', system2Model: null },
)
assert.deepEqual(partial, {
  serverVersion: '1.21.11',
  difficulty: null,
  jevModel: 'deterministic-local-fallback',
  system2Model: null,
})

console.log('acceptance-metadata: 3/3 checks passed')
