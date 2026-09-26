// system2-harness/prompt.ts - the ONE registered System2 prompt path
// (#439 sections 1/2/4/22/26/28; invariant S2).
//
// There is exactly one prompt builder for the long-horizon question, and it is
// registered below. A call site may not construct its own System2 prompt: the
// static invariant test fails CI when a provider call path outside this registry
// appears (see bun-tests/invariants.test.ts).

import { canonicalJson } from './canonical.ts'
import { PREDICATE_KINDS } from './contract.ts'
import { INTERACT_OPERATIONS, FIND_DOMAINS, STATION_KINDS } from './predicateRegistry.ts'
import type { System2ProjectionPayload } from './stateProjection.ts'
import { PROMPT_VERSION } from './versions.ts'

export const SYSTEM2_PROMPT_ID = 'system2.propose'
export const SYSTEM2_PROMPT_VERSION = PROMPT_VERSION

export interface RegisteredPrompt {
  readonly id: string
  readonly version: number
  readonly purpose: string
  readonly callPath: string
}

/** Registry of sanctioned model call paths (#439 section 1 / S2). */
export const REGISTERED_SYSTEM2_PROMPTS: readonly RegisteredPrompt[] = Object.freeze([
  {
    id: SYSTEM2_PROMPT_ID,
    version: SYSTEM2_PROMPT_VERSION,
    purpose: 'propose the next WHAT as typed generic intents/predicates',
    callPath: 'system2-harness/harness.ts#System2Harness.propose',
  },
])

export interface System2PromptInput {
  /** The versioned System2 projection; exactly the schema the harness owns. */
  readonly projection: System2ProjectionPayload
}

/**
 * Render the prompt. It states the contract the compiler enforces:
 * typed predicates are the only authority, prose is diagnostic, unknown targets
 * stay symbolic, and no primitive action sequence is accepted.
 */
export function buildSystem2Prompt(input: System2PromptInput): string {
  const vocabulary = {
    predicateKinds: PREDICATE_KINDS,
    interactOperations: INTERACT_OPERATIONS,
    findDomains: FIND_DOMAINS,
    stationKinds: STATION_KINDS,
  }
  return [
    'You are the long-horizon WHAT author for an embodied Minecraft agent.',
    'Answer with ONE JSON object and nothing else. The JSON must match this schema:',
    '{"operation":"replace|append|suspend|resume|repair",',
    ' "rationale":"free-form diagnostic text, ignored by all authority",',
    ' "intents":[{"intentText":"short human description",',
    '  "desiredPredicates":[{"kind":"<predicate kind>","args":{...}}],',
    '  "dependencies":[{"kind":"<predicate kind>","args":{...}}],',
    '  "targetRef":{"kind":"grounded","refKind":"<ref kind>","refId":"<id from the state>"},',
    '  "completionSemantics":"all|any"}]}',
    '',
    `Allowed predicate kinds: ${PREDICATE_KINDS.join(', ')}.`,
    `interact operations: ${INTERACT_OPERATIONS.join(', ')}. find domains: ${FIND_DOMAINS.join(', ')}.`,
    `establish stations: ${STATION_KINDS.join(', ')}.`,
    '',
    'Rules:',
    '- Only reference refs that appear in the state below. An id that is not in the state is rejected.',
    '- Never emit coordinates, block positions, path nodes or primitive step sequences.',
    '- If a target is not grounded, use a symbolic ref ({"kind":"symbolic","description":"..."}) and let code search.',
    '- rationale is diagnostic only: text in it never becomes a goal.',
    '- Keep the horizon small: at most a few intents and dependencies.',
    '- Do not assume any benchmark or milestone order. Use only the facts and unknowns below.',
    '',
    'System2 semantic state (versioned projection):',
    canonicalJson(input.projection as unknown as Record<string, unknown>),
  ].join('\n')
}
