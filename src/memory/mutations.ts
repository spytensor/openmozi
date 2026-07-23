import { getDb } from '../store/db.js';
import {
  getAccessibleFacts,
  getFacts,
  saveFact,
  updateFactStatus,
  updateFactValue,
  type FactCategory,
  type MemoryAccessScope,
  type MemoryFact,
  type MemoryFactStatus,
  type MemoryOriginKind,
} from './long-term.js';
import { hanTokenLength, isHanToken, tokenizeText } from './text-tokenizer.js';

export type MemoryMutationAction = 'ADD' | 'REINFORCE' | 'UPDATE' | 'NOOP';
export type RequestedMemoryMutationAction = 'AUTO' | 'ADD' | 'REINFORCE' | 'UPDATE';

export interface MemoryMutationInput {
  chatId: string;
  tenantId?: string;
  userId?: string;
  turnId?: string;
  category: FactCategory;
  key: string;
  value: string;
  source: string;
  requestedAction?: RequestedMemoryMutationAction;
  targetFactId?: number;
  salienceHint?: number;
  status?: MemoryFactStatus;
  originKind?: MemoryOriginKind;
  candidateScope?: 'user' | 'chat';
}

export interface MemoryMutationResult {
  action: MemoryMutationAction;
  fact: MemoryFact;
}

export interface MemoryTurnUpdate {
  factId: number;
  action: Exclude<MemoryMutationAction, 'NOOP'>;
  category: FactCategory;
}

function accessScope(input: MemoryMutationInput): MemoryAccessScope | undefined {
  if (!input.userId) return undefined;
  return { userId: input.userId, accessibleChatIds: [input.chatId, '__semantic__'] };
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
}

function tokens(value: string): Set<string> {
  const parsed = tokenizeText(value);
  const hasContentToken = parsed.some(token => !isHanToken(token) || hanTokenLength(token) >= 2);
  return new Set(hasContentToken
    ? parsed.filter(token => !isHanToken(token) || hanTokenLength(token) >= 2)
    : parsed);
}

function lexicalSimilarity(aValue: string, bValue: string): number {
  const a = tokens(aValue);
  const b = tokens(bValue);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function chooseCandidate(input: MemoryMutationInput, facts: MemoryFact[]): MemoryFact | undefined {
  if (input.targetFactId != null) {
    const targeted = facts.find(fact => fact.id === input.targetFactId);
    if (targeted) return targeted;
  }

  const normalizedIncomingKey = normalizeKey(input.key);
  const exactKey = facts
    .filter(fact => normalizeKey(fact.key) === normalizedIncomingKey)
    .sort((a, b) => Number(b.category === input.category) - Number(a.category === input.category))[0];
  if (exactKey) return exactKey;

  const exactValue = facts.find(fact => fact.value.trim().toLowerCase() === input.value.trim().toLowerCase());
  if (exactValue) return exactValue;

  // This deliberately remains conservative. The background extractor receives
  // candidate ids and resolves paraphrases with the LLM; this fallback only
  // catches near-verbatim repeats when that resolver is unavailable.
  return facts
    .map(fact => ({ fact, score: lexicalSimilarity(fact.value, input.value) }))
    .filter(candidate => candidate.score > 0.8)
    .sort((a, b) => b.score - a.score)[0]?.fact;
}

function readFact(factId: number, tenantId: string): MemoryFact {
  const fact = getDb().prepare(`
    SELECT id, tenant_id, chat_id, user_id, category, key, value, confidence,
           salience_score, source, status, origin_kind, recall_count, last_recalled_at, created_at, updated_at
    FROM memory_facts WHERE id = ? AND tenant_id = ?
  `).get(factId, tenantId) as MemoryFact | undefined;
  if (!fact) throw new Error(`Memory fact ${factId} disappeared after mutation`);
  return fact;
}

function hasTurnEvidence(tenantId: string, factId: number, turnId?: string): boolean {
  if (!turnId) return false;
  return Boolean(getDb().prepare(`
    SELECT 1 FROM memory_fact_evidence
    WHERE tenant_id = ? AND fact_id = ? AND turn_id = ?
  `).get(tenantId, factId, turnId));
}

function recordEvidence(
  input: MemoryMutationInput,
  factId: number,
  action: Exclude<MemoryMutationAction, 'NOOP'>,
  previousFact?: MemoryFact,
): void {
  const fact = readFact(factId, input.tenantId ?? 'default');
  getDb().prepare(`
    INSERT OR IGNORE INTO memory_fact_evidence (
      tenant_id, fact_id, chat_id, user_id, turn_id, action, source,
      value_snapshot, status_snapshot, origin_kind,
      previous_value_snapshot, previous_status_snapshot, previous_origin_kind, previous_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.tenantId ?? 'default',
    factId,
    input.chatId,
    input.userId ?? null,
    input.turnId ?? null,
    action,
    input.source,
    fact.value,
    fact.status,
    fact.origin_kind,
    previousFact?.value ?? null,
    previousFact?.status ?? null,
    previousFact?.origin_kind ?? null,
    previousFact?.source ?? null,
  );
}

/**
 * Apply one durable memory mutation through the shared write contract.
 * Both the explicit remember tool and background extraction use this entrypoint.
 */
export function applyMemoryMutation(input: MemoryMutationInput): MemoryMutationResult {
  const tenantId = input.tenantId ?? 'default';
  const accessibleFacts = input.candidateScope === 'chat'
    ? getFacts(input.chatId, undefined, tenantId, accessScope(input), true)
    : getAccessibleFacts(tenantId, accessScope(input));
  // Project facts have a stricter promotion contract than ordinary personal
  // memory. A normal extractor/tool call must never target one by id, key, or
  // lexical similarity; only a project-scoped mutation may consider them.
  const facts = input.chatId.startsWith('__project__')
    ? accessibleFacts.filter(fact => fact.chat_id === input.chatId)
    : accessibleFacts.filter(fact => !fact.chat_id.startsWith('__project__'));
  const candidate = chooseCandidate(input, facts);

  if (candidate && hasTurnEvidence(tenantId, candidate.id, input.turnId)) {
    return { action: 'NOOP', fact: candidate };
  }

  if (!candidate) {
    saveFact(
      input.chatId,
      input.category,
      input.key,
      input.value,
      input.source,
      tenantId,
      input.userId,
      input.salienceHint,
      input.status ?? 'active',
      input.originKind ?? 'legacy',
    );
    const created = getAccessibleFacts(tenantId, accessScope(input), undefined, true).find(fact => (
      fact.chat_id === input.chatId && fact.category === input.category && fact.key === input.key
    ));
    if (!created) throw new Error('Memory add completed without a readable fact');
    recordEvidence(input, created.id, 'ADD');
    return { action: 'ADD', fact: created };
  }

  const requestedAction = input.requestedAction ?? 'AUTO';
  const sameCanonicalKey = normalizeKey(candidate.key) === normalizeKey(input.key);
  const valueChanged = candidate.value.trim() !== input.value.trim();
  const shouldUpdate = valueChanged && (
    requestedAction === 'UPDATE'
    || (requestedAction === 'AUTO' && sameCanonicalKey && lexicalSimilarity(candidate.value, input.value) <= 0.8)
  );
  if (shouldUpdate) {
    const updatedValue = updateFactValue(candidate.id, input.value, tenantId, accessScope(input));
    if (!updatedValue) throw new Error(`Memory fact ${candidate.id} is not accessible for update`);
    getDb().prepare(`
      UPDATE memory_facts
      SET source = ?,
          user_id = COALESCE(?, user_id),
          status = ?,
          origin_kind = ?,
          salience_score = MAX(salience_score, ?),
          updated_at = datetime('now')
      WHERE id = ? AND tenant_id = ?
    `).run(
      input.source,
      input.userId ?? null,
      input.status ?? candidate.status,
      input.originKind ?? candidate.origin_kind,
      input.salienceHint ?? candidate.salience_score,
      candidate.id,
      tenantId,
    );
    const updated = readFact(candidate.id, tenantId);
    recordEvidence(input, updated.id, 'UPDATE', candidate);
    return { action: 'UPDATE', fact: updated };
  }

  getDb().prepare(`
    UPDATE memory_facts
    SET user_id = COALESCE(?, user_id),
        status = ?,
        origin_kind = ?,
        confidence = MIN(1.0, confidence + 0.02),
        salience_score = MIN(1.0, salience_score + 0.08),
        updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(
    input.userId ?? null,
    input.status ?? candidate.status,
    input.originKind ?? candidate.origin_kind,
    candidate.id,
    tenantId,
  );
  const reinforced = readFact(candidate.id, tenantId);
  recordEvidence(input, reinforced.id, 'REINFORCE', candidate);
  return { action: 'REINFORCE', fact: reinforced };
}

/** Review or retract a memory through the same evidence contract as other writes. */
export function setMemoryFactStatus(
  factId: number,
  status: MemoryFactStatus,
  input: Pick<MemoryMutationInput, 'chatId' | 'tenantId' | 'userId' | 'turnId' | 'source'>,
  scope?: MemoryAccessScope,
  promotion?: { chatId: string; userId: string },
): MemoryFact | null {
  const tenantId = input.tenantId ?? 'default';
  let previousFact: MemoryFact;
  try {
    previousFact = readFact(factId, tenantId);
  } catch {
    return null;
  }
  const fact = updateFactStatus(
    factId,
    status,
    tenantId,
    scope,
    status === 'active' ? 'user' : undefined,
    promotion,
  );
  if (!fact) return null;
  recordEvidence({
    ...input,
    tenantId,
    category: fact.category,
    key: fact.key,
    value: fact.value,
    status,
    originKind: fact.origin_kind,
  }, fact.id, 'UPDATE', previousFact);
  return fact;
}

/** Return the committed memory changes associated with one turn. */
export function getMemoryTurnUpdates(turnId: string, tenantId = 'default'): MemoryTurnUpdate[] {
  return getDb().prepare(`
    SELECT e.fact_id AS factId, e.action, f.category
    FROM memory_fact_evidence e
    JOIN memory_facts f ON f.id = e.fact_id AND f.tenant_id = e.tenant_id
    WHERE e.tenant_id = ? AND e.turn_id = ?
    ORDER BY e.id ASC
  `).all(tenantId, turnId) as MemoryTurnUpdate[];
}
