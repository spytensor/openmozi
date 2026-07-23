/**
 * One-off script: recover memory facts from conversations that were missed
 * due to MiniMax balance exhaustion (Feb 28 - Mar 1, 2026).
 *
 * Usage: npx tsx scripts/recover-memory.ts
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { config as loadDotenv } from 'dotenv';

// Load env vars from ~/.mozi/.env
loadDotenv({ path: join(homedir(), '.mozi', '.env') });

const DB_PATH = join(homedir(), '.mozi', 'data', 'mozi.db');
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const RECOVERY_CHAT_ID = process.env.MOZI_RECOVERY_CHAT_ID;

if (!DEEPSEEK_API_KEY || !RECOVERY_CHAT_ID) {
  console.error('DEEPSEEK_API_KEY and MOZI_RECOVERY_CHAT_ID must be set');
  process.exit(1);
}

const EXTRACTION_PROMPT = `Given this conversation turn, extract any of: preferences, facts, decisions, corrections.
Focus on personal facts about the user (location, plans, travel, work, relationships) and important context.
Output JSON only: {"preferences":[], "facts":[], "decisions":[], "corrections":[]}.
Each item should be {key: string, value: string}. Empty arrays if nothing worth remembering.`;

interface ConversationRow {
  id: number;
  role: string;
  content: string;
  created_at: string;
}

async function callDeepSeek(messages: Array<{ role: string; content: string }>): Promise<string> {
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      max_tokens: 500,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`DeepSeek API error ${resp.status}: ${text}`);
  }

  const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? '';
}

function normalizeKey(input: string, fallbackPrefix: string, index: number): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return normalized || `${fallbackPrefix}_${index + 1}`;
}

async function main() {
  const db = new Database(DB_PATH);

  // Get all messages from the gap period
  const rows = db.prepare(
    `SELECT id, role, content, created_at FROM conversations
     WHERE chat_id = ?
     AND created_at BETWEEN '2026-02-28' AND '2026-03-02'
     ORDER BY created_at`
  ).all(RECOVERY_CHAT_ID) as ConversationRow[];

  console.log(`Found ${rows.length} messages in gap period`);

  // Pair user + assistant messages
  const pairs: Array<{ user: string; assistant: string; date: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].role === 'user') {
      // Find the next assistant response
      const assistant = rows.slice(i + 1).find(r => r.role === 'assistant');
      if (assistant && assistant.content.trim()) {
        pairs.push({
          user: rows[i].content,
          assistant: assistant.content,
          date: rows[i].created_at,
        });
      }
    }
  }

  console.log(`Found ${pairs.length} user-assistant pairs to process`);

  // Batch: group into chunks of 5 conversation turns for efficiency
  const BATCH_SIZE = 5;
  let totalFacts = 0;
  let totalErrors = 0;

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO memory_facts (tenant_id, chat_id, user_id, category, key, value, confidence, source, recall_count, salience_score, created_at, updated_at)
     VALUES ('default', ?, ?, ?, ?, ?, 0.7, 'recovery_extract', 0, 0.5, ?, ?)`
  );

  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    const conversationText = batch
      .map(p => `[${p.date}]\nUser: ${p.user.slice(0, 300)}\nAssistant: ${p.assistant.slice(0, 300)}`)
      .join('\n---\n');

    try {
      const result = await callDeepSeek([
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: conversationText },
      ]);

      // Parse JSON from response
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log(`  Batch ${i / BATCH_SIZE + 1}: no JSON found, skipping`);
        continue;
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown[]>;
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const batchDate = batch[0].date;
      let batchCount = 0;

      for (const [category, items] of Object.entries(parsed)) {
        if (!Array.isArray(items)) continue;
        const cat = category === 'corrections' ? 'fact' : category.replace(/s$/, '') as string;

        for (let j = 0; j < items.length; j++) {
          const item = items[j] as { key?: string; value?: string } | string;
          let key: string, value: string;

          if (typeof item === 'string') {
            key = normalizeKey(item, cat, j);
            value = item;
          } else if (item && typeof item === 'object' && item.value) {
            key = normalizeKey(item.key ?? item.value, cat, j);
            value = item.value;
          } else {
            continue;
          }

          // Prefix key with 'recovery_' to distinguish
          const finalKey = `recovery_${key}`;
          try {
            insertStmt.run(RECOVERY_CHAT_ID, RECOVERY_CHAT_ID, cat, finalKey, value, batchDate, now);
            batchCount++;
          } catch {
            // duplicate key, skip
          }
        }
      }

      totalFacts += batchCount;
      console.log(`  Batch ${i / BATCH_SIZE + 1}/${Math.ceil(pairs.length / BATCH_SIZE)}: extracted ${batchCount} facts`);

      // Rate limit: 200ms between batches
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      totalErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Batch ${i / BATCH_SIZE + 1}: ERROR — ${msg}`);
    }
  }

  console.log(`\nDone! Recovered ${totalFacts} facts, ${totalErrors} errors`);

  // Verify
  const count = db.prepare(
    `SELECT count(*) as cnt FROM memory_facts WHERE source = 'recovery_extract'`
  ).get() as { cnt: number };
  console.log(`Total recovery facts in DB: ${count.cnt}`);

  db.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
