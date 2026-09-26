import { readFileSync } from 'node:fs'
const KEY = readFileSync('/home/s0u7a/.config/kimaki-secrets/vercel-ai-gateway.key','utf8').trim()
const paths = ['/v1/evaluations','/v1/evaluation','/v1/evaluate','/v1/gen/evaluation','/v1/evaluation/completions','/v1/evaluations/generate','/v1/system-one','/v1/typesafe']
const body = { model:'typesafe-ai/jev', state:'{"goal":"test"}', questions:{q:{type:'noul',instructions:'is this a test'}} }
for (const p of paths) {
  let status=0, text=''
  try {
    const r = await fetch('https://ai-gateway.vercel.sh'+p, { method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${KEY}`}, body: JSON.stringify(body) })
    status = r.status; text = await r.text()
  } catch (e) { text = 'err '+e.message }
  console.log(`${p} -> ${status} ${text.slice(0,180).replace(/\s+/g,' ')}`)
}
// also ask the models endpoint for the Jev entry's endpoints/spec details
const r = await fetch('https://ai-gateway.vercel.sh/v1/models', { headers:{authorization:`Bearer ${KEY}`} })
const d = await r.json()
const m = d.data.find(x=>x.id==='typesafe-ai/jev')
console.log('\nJEV ENTRY:', JSON.stringify(m).slice(0,700))
