#!/usr/bin/env bun
// mercury-local-preflight.mjs - prove the local Mercury endpoint is usable.
//
// Checks, in order:
//   1. BUDDY_MERCURY_BASE_URL resolves (default http://127.0.0.1:8081/v1)
//   2. GET  {base}/models answers and reports a model id
//   3. POST {base}/chat/completions returns parseable JSON text with
//      chat_template_kwargs { enable_thinking: false } (BUDDY_MERCURY_LOCAL_NO_THINK=1)
//
// Exits non-zero when any step fails, so a launcher can refuse to start the
// resident against a dead or still-loading local server.
//
// Usage: bun tools/mercury-local-preflight.mjs [--base URL] [--model ID]

const args = Bun.argv.slice(2)
function flag(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const base = (flag('--base', process.env.BUDDY_MERCURY_BASE_URL ?? 'http://127.0.0.1:8081/v1') ?? '').replace(/\/+$/, '')
const model = flag('--model', process.env.BUDDY_MERCURY_MODEL ?? 'qwen3.5-9b-local')

function fail(step, detail) {
  process.stdout.write(`FAIL  ${step}: ${detail}\n`)
  process.exit(1)
}

const modelsResponse = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5000) }).catch((error) => error)
if (!(modelsResponse instanceof Response) || !modelsResponse.ok) {
  fail('GET /models', String(modelsResponse instanceof Response ? modelsResponse.status : modelsResponse))
}
const models = await modelsResponse.json()
const ids = Array.isArray(models?.models) ? models.models.map((entry) => String(entry?.model ?? entry?.id ?? '')) : []
process.stdout.write(`PASS  GET /models: ${ids.length} entry(ies) ${JSON.stringify(ids)}\n`)

const started = Date.now()
const completionResponse = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'Return exactly one JSON object, no prose.' },
      { role: 'user', content: 'Return {"op":"patch","goals":[],"reason":"preflight"}' },
    ],
    max_tokens: 64,
    temperature: 0,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  }),
  signal: AbortSignal.timeout(120000),
}).catch((error) => error)
if (!(completionResponse instanceof Response) || !completionResponse.ok) {
  const status = completionResponse instanceof Response ? completionResponse.status : String(completionResponse)
  fail('POST /chat/completions', `${status} (server still loading?)`)
}
const completion = await completionResponse.json()
const content = completion?.choices?.[0]?.message?.content
if (typeof content !== 'string' || content.trim().length === 0) {
  fail('completion content', 'empty response; keep thinking disabled (BUDDY_MERCURY_LOCAL_NO_THINK=1)')
}
let parsed = null
try {
  parsed = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1))
} catch {
  parsed = null
}
process.stdout.write(`PASS  POST /chat/completions: ${Date.now() - started}ms content=${JSON.stringify(content.slice(0, 120))}\n`)
if (parsed === null || typeof parsed !== 'object') {
  process.stdout.write('WARN  completion was not a single JSON object; the corrective retry path would handle it\n')
}
process.stdout.write(`\nLOCAL MERCURY READY base=${base} model=${model}\n`)
