// One-time, single-use key drop page.
// - Random secret path (32 hex chars) is the only way in.
// - Accepts a POST once, writes the value to a 0600 file, then exits.
// - Never logs or echoes the submitted value.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const OUT = '/home/s0u7a/.config/kimaki-secrets/vercel-ai-gateway.key'
const TOKEN = randomBytes(16).toString('hex')
const PATH = `/k/${TOKEN}`
const PORT = Number(process.env.PORT || 39321)
const MAX_BYTES = 8192

const already = existsSync(OUT)
  ? `A key file already exists (${statSync(OUT).size} bytes, mode ${(statSync(OUT).mode & 0o777).toString(8)}). Submitting will OVERWRITE it.`
  : 'No key file yet.'

const page = (msg = '') => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>key drop</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:1.5rem;background:#111;color:#eee}
 h1{font-size:1.1rem;margin:0 0 .75rem}
 p{color:#aaa;font-size:.85rem;margin:.5rem 0 1rem;white-space:pre-wrap}
 form{display:flex;flex-direction:column;gap:.75rem;max-width:34rem}
 input,button{font:inherit;padding:.7rem;border-radius:.5rem;border:1px solid #444;background:#1b1b1b;color:#eee}
 button{background:#2b7;border:0;font-weight:600;color:#04140c}
 .m{background:#062;padding:.6rem;border-radius:.5rem;font-size:.9rem}
</style></head><body>
<h1>Vercel AI Gateway key drop (one-time)</h1>
${msg ? `<div class="m">${msg}</div>` : ''}
<p>${already}

送信するとこのPCの 0600 ファイルに直接保存され、このページは即停止します。
キーはログ・Discord・チャットには残りません。</p>
<form method="POST" action="${PATH}">
 <input name="key" type="password" placeholder="vck_..." autocomplete="off" autocapitalize="off" spellcheck="false" required>
 <button type="submit">保存（1回だけ）</button>
</form>
</body></html>`

let used = false

const server = createServer((req, res) => {
  if (req.url !== PATH) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page())
    console.log('[keydrop] served form')
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  if (used) {
    res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('already used')
    return
  }
  let body = ''
  let tooBig = false
  req.on('data', (c) => {
    body += c
    if (body.length > MAX_BYTES) { tooBig = true; req.destroy() }
  })
  req.on('end', () => {
    if (tooBig) { res.writeHead(413).end(); return }
    used = true
    const form = new URLSearchParams(body)
    const raw = (form.get('key') || '').trim()
    // accept an optional "export FOO=" / "FOO=" wrapper, keep only the token value
    const m = raw.match(/(?:^|\s)(?:export\s+)?[A-Z0-9_]*KEY\s*=\s*['"]?([^\s'"]+)/)
    const key = (m ? m[1] : raw).replace(/\s+/g, '')
    if (!/^[\x21-\x7e]{8,512}$/.test(key)) {
      used = false
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page('拒否: 形式が不正です（空白や制御文字を含む / 短すぎる）'))
      console.log('[keydrop] rejected a malformed submission (%d bytes)', raw.length)
      return
    }
    mkdirSync(dirname(OUT), { recursive: true, mode: 0o700 })
    writeFileSync(OUT, key, { mode: 0o600 })
    chmodSync(OUT, 0o600)
    const written = statSync(OUT)
    console.log('[keydrop] saved submission: %d bytes, mode %s (value not logged)', written.size, (written.mode & 0o777).toString(8))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page('保存しました。このページは停止します。Discordに戻って「送信した」と伝えてください。'))
    setTimeout(() => { server.close(() => process.exit(0)) }, 800)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[keydrop] listening on http://127.0.0.1:${PORT}${PATH}`)
  console.log('[keydrop] single-use; exits after one successful save')
})
