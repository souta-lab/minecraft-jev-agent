export const HUMAN_INTENT_MAX_COUNT = 4096

export type HumanIntentCommand =
  | { kind: 'collect'; item: string; count: number | null; raw: string }
  | { kind: 'status'; raw: string }
  | { kind: 'stop'; raw: string }
  | { kind: 'free'; raw: string }
  | { kind: 'invalid'; reason: string; raw: string }

const ITEM_ALIASES: Readonly<Record<string, string>> = {
  diamond: 'diamond',
  diamonds: 'diamond',
  'ダイヤ': 'diamond',
  'ダイヤモンド': 'diamond',
  obsidian: 'obsidian',
  '黒曜石': 'obsidian',
  coal: 'coal',
  '石炭': 'coal',
  cobblestone: 'cobblestone',
  '丸石': 'cobblestone',
  flint: 'flint',
  '火打石': 'flint',
  ender_pearl: 'ender_pearl',
  'エンダーパール': 'ender_pearl',
  blaze_rod: 'blaze_rod',
  'ブレイズロッド': 'blaze_rod',
  raw_iron: 'raw_iron',
  '原鉄': 'raw_iron',
  log: 'log',
  logs: 'log',
  '原木': 'log',
}

function normalizeSpaces(value: string): string {
  return value.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim()
}

function normalizedAgent(value: string): string {
  return value.trim().toLowerCase()
}

function countFromBody(body: string): number | null | 'invalid' {
  const match = body.match(/(?:^|\s|を|x|×)(\d{1,5})(?:\s*(?:個|こ|x|×))?(?:\s|$|を|掘|集|取|採)/i)
    ?? body.match(/(\d{1,5})\s*(?:個|こ|x|×)/i)
  if (match === null) return null
  const count = Number(match[1])
  if (!Number.isInteger(count) || count < 1 || count > HUMAN_INTENT_MAX_COUNT) return 'invalid'
  return count
}

function itemFromBody(body: string): string | null {
  const lower = body.toLowerCase()
  const aliases = Object.keys(ITEM_ALIASES).sort((a, b) => b.length - a.length)
  for (const alias of aliases) {
    if (lower.includes(alias.toLowerCase())) return ITEM_ALIASES[alias] ?? null
  }
  const ascii = lower.match(/(?:collect\s+)?([a-z][a-z0-9_]{1,63})/)
  if (ascii === null) return null
  const token = ascii[1]
  if (token === undefined || ['collect', 'mine', 'get', 'fetch', 'status', 'stop', 'free'].includes(token)) return null
  return token
}

export function parseQuantityReply(message: string): number | null {
  const normalized = normalizeSpaces(message)
  const match = normalized.match(/^(\d{1,5})\s*(?:個|こ|x|×)?$/i)
  if (match === null) return null
  const count = Number(match[1])
  return Number.isInteger(count) && count >= 1 && count <= HUMAN_INTENT_MAX_COUNT ? count : null
}

/**
 * Parse the stable `/agent <name> ...` grammar. Runtime chat may deliver the
 * same text without the leading slash, so both forms are accepted here.
 */
export function parseHumanIntentCommand(message: string, agentName: string): HumanIntentCommand | null {
  const normalized = normalizeSpaces(message)
  const match = normalized.match(/^\/?agent\s+(\S+)\s*(.*)$/i)
  if (match === null) return null
  const target = match[1] ?? ''
  const body = (match[2] ?? '').trim()
  if (normalizedAgent(target) !== normalizedAgent(agentName)) return null
  if (body.length === 0) return { kind: 'invalid', reason: 'command_missing', raw: normalized }

  const lower = body.toLowerCase()
  if (/^(status|state|状態|状況|今何してる|今なにしてる|何してる|なにしてる)[?？]?$/.test(lower)) {
    return { kind: 'status', raw: normalized }
  }
  if (/^(stop|cancel|停止|中止|やめて|止まって|待って)[!！]?$/.test(lower)) {
    return { kind: 'stop', raw: normalized }
  }
  if (/^(free|release|自由|自由にして|解放|自律に戻って)[!！]?$/.test(lower)) {
    return { kind: 'free', raw: normalized }
  }

  const looksCollect =
    /^(collect|mine|get|fetch)\b/i.test(body) ||
    /(掘って|掘れ|集めて|集めろ|取って|取れ|採って|採れ|持ってきて|とってきて)/.test(body) ||
    itemFromBody(body) !== null
  if (!looksCollect) return { kind: 'invalid', reason: 'unsupported_intent', raw: normalized }

  const item = itemFromBody(body)
  if (item === null) return { kind: 'invalid', reason: 'item_missing', raw: normalized }
  const count = countFromBody(body)
  if (count === 'invalid') return { kind: 'invalid', reason: 'count_out_of_range', raw: normalized }
  return { kind: 'collect', item, count, raw: normalized }
}
