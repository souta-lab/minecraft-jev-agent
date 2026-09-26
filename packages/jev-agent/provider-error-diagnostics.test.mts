import assert from 'node:assert/strict'
import { describe, it } from 'bun:test'
import { APICallError } from 'ai'
import { APIError } from '@typesafe-ai/sdk'
import { describeProviderError, extractProviderErrorDiagnostics } from './src/jev/authority.ts'

const vercelId = 'hnd1::cle1::audit-1234567890'
const secret = 'super-secret-token-123456789'

describe('Jev provider error diagnostics', () => {
  it('extracts safe fields from AI SDK APICallError without logging request secrets', () => {
    const error = new APICallError({
      message: `GatewayInternalServerError: Service temporarily unavailable. Authorization: Bearer ${secret}`,
      url: 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model?api_key=do-not-log-this',
      requestBodyValues: { apiKey: secret },
      statusCode: 503,
      responseHeaders: {
        'x-vercel-id': vercelId,
        'x-request-id': 'fallback-request-id-1234',
        authorization: `Bearer ${secret}`,
        cookie: secret,
      },
      responseBody: JSON.stringify({ error: { code: 'provider_overloaded', message: 'upstream unavailable', api_key: secret } }),
      isRetryable: true,
    })
    const event = {
      error: describeProviderError(error),
      providerDiagnostics: extractProviderErrorDiagnostics(error),
    }

    assert.deepEqual(event.providerDiagnostics, {
      httpStatus: 503,
      providerErrorCode: 'provider_overloaded',
      errorName: 'AI_APICallError',
      requestId: vercelId,
      requestIdHeader: 'x-vercel-id',
    })
    assert.ok(!JSON.stringify(event).includes(secret))
    assert.ok(!JSON.stringify(event).includes('requestBodyValues'))
    assert.match(event.error, /Authorization=\[REDACTED\]/)
  })

  it('extracts TypeSafe APIError status, code, and Headers-based request IDs', () => {
    const error = new APIError(
      502,
      { error: { code: 'upstream_unavailable', type: 'gateway_error', api_key: secret } },
      new Headers({
        'x-vercel-id': vercelId,
        'x-typesafe-request-id': 'typesafe-request-1234',
        authorization: `Bearer ${secret}`,
      }),
    )

    assert.deepEqual(extractProviderErrorDiagnostics(error), {
      httpStatus: 502,
      providerErrorCode: 'upstream_unavailable',
      providerErrorType: 'gateway_error',
      errorName: 'APIError',
      requestId: vercelId,
      requestIdHeader: 'x-vercel-id',
    })
  })

  it('follows bounded retry-wrapper cause chains and prefers Vercel request IDs', () => {
    const error: Record<string, unknown> = { name: 'Error', message: 'provider retry wrapper' }
    error.lastError = {
      statusCode: 504,
      responseHeaders: { 'X-Vercel-Request-Id': 'iad1::sfo1::nested-1234' },
      responseBody: JSON.stringify({ error: { code: 'provider_timeout' } }),
    }
    error.cause = error

    assert.deepEqual(extractProviderErrorDiagnostics(error), {
      httpStatus: 504,
      providerErrorCode: 'provider_timeout',
      errorName: 'Error',
      requestId: 'iad1::sfo1::nested-1234',
      requestIdHeader: 'x-vercel-request-id',
    })
  })

  it('redacts credential-like message values and never serializes bodies or headers wholesale', () => {
    const error = {
      name: 'GatewayInternalServerError',
      message: `rejected Authorization: Bearer ${secret}; api_key=${secret}`,
      statusCode: 503,
      responseHeaders: {
        authorization: `Bearer ${secret}`,
        cookie: secret,
        'x-vercel-id': vercelId,
      },
      responseBody: JSON.stringify({ error: { code: 'opaque-secret-token-value', message: secret } }),
      requestBodyValues: { apiKey: secret, state: 'never serialized' },
    }
    const event = {
      error: describeProviderError(error),
      providerDiagnostics: extractProviderErrorDiagnostics(error),
    }
    const serialized = JSON.stringify(event)

    assert.ok(!serialized.includes(secret))
    assert.ok(!serialized.includes('opaque-secret-token-value'))
    assert.ok(!serialized.includes('requestBodyValues'))
    assert.match(serialized, /"httpStatus":503/)
    assert.ok(serialized.includes(vercelId))
    assert.match(event.error, /Authorization=\[REDACTED\]/)
  })

  it('rejects malformed diagnostics and supports a direct requestId field', () => {
    assert.equal(extractProviderErrorDiagnostics({ statusCode: 600, code: 'api_key_secret', requestId: secret }), null)
    assert.deepEqual(extractProviderErrorDiagnostics({ status: 429, requestId: 'request-id-1234' }), {
      httpStatus: 429,
      requestId: 'request-id-1234',
      requestIdHeader: 'requestId',
    })
  })
})
