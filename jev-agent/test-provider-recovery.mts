import assert from 'node:assert/strict'
import { isTransientProviderFailure } from './src/jev-authority.ts'

assert.equal(isTransientProviderFailure({ statusCode: 503, message: 'unavailable' }), true)
assert.equal(isTransientProviderFailure({ cause: { status: 502, message: 'bad gateway' } }), true)
assert.equal(isTransientProviderFailure(new Error('GatewayInternalServerError: Service temporarily unavailable')), true)
assert.equal(isTransientProviderFailure('connection reset by peer'), true)
assert.equal(isTransientProviderFailure({ code: 'EAI_AGAIN', message: 'temporary DNS failure' }), true)
assert.equal(isTransientProviderFailure({ cause: { code: 'ECONNREFUSED' } }), true)
assert.equal(isTransientProviderFailure({ status: 400, message: 'invalid request' }), false)
assert.equal(isTransientProviderFailure(new Error('schema mismatch')), false)

console.log('provider recovery classification: PASS')
