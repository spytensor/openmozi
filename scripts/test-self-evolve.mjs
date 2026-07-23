/**
 * Self-Evolution Test — Give MOZI a real coding task and observe
 * whether it can use its tools to read, understand, and modify its own code.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load env
if (readFileSync('.env', 'utf-8')) {
  for (const line of readFileSync('.env', 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx);
      const value = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

const { loadConfig, getConfig } = await import('./dist/config/index.js');
const { initDb } = await import('./dist/store/db.js');
const { runMigrations } = await import('./dist/store/migrate.js');
const { handleMessage } = await import('./dist/gateway/handler.js');
const { create } = await import('./dist/core/llm.js');
const { loadDynamicToolsFromDb } = await import('./dist/tools/dynamic-registry.js');

loadConfig();
initDb();
runMigrations();
loadDynamicToolsFromDb();

const client = create('openai', { model: 'gpt-4.1-mini' });
const systemPrompt = readFileSync(resolve('workspace', 'SOUL.md'), 'utf-8');

const progress = {
  onProcessingStart: () => console.log('[progress] Processing started'),
  onToolStart: (n) => console.log(`[tool_start] ${n}`),
  onToolEnd: (n) => console.log(`[tool_end] ${n}`),
  onStreamChunk: () => {},
  onStreamEnd: () => {},
};

const CHAT_ID = 'self_evolve_test_' + Date.now();

async function sendTask(taskText) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[TASK] ${taskText.slice(0, 100)}...`);
  console.log('='.repeat(60));

  const msg = {
    channelType: 'test',
    chatId: CHAT_ID,
    userId: 'tester',
    username: 'mozi_self_test',
    text: taskText,
    isCommand: false,
    timestamp: new Date(),
  };

  const startTime = Date.now();
  try {
    const response = await handleMessage(msg, systemPrompt, client, progress);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n[RESPONSE] (${elapsed}s)`);
    console.log(response);
    return response;
  } catch (err) {
    console.log(`[ERROR] ${err.message}`);
    return null;
  }
}

// ============================================================
// Task 1: Can MOZI read and understand its own architecture?
// ============================================================
console.log('\n\n### TEST 1: Self-Awareness — Can MOZI read its own code?\n');

const r1 = await sendTask(
  'Read the file src/channels/telegram.ts and tell me: what function handles sending bot replies back to users? What is the exact function name and how does it work? Be specific — quote the relevant code.'
);

// ============================================================
// Task 2: Can MOZI identify a bug in its own code?
// ============================================================
console.log('\n\n### TEST 2: Bug Detection — Can MOZI find the streaming duplicate message bug?\n');

const r2 = await sendTask(
  'There is a bug in how streaming responses work in Telegram. Read src/index.ts and src/channels/telegram.ts. The issue is: when streaming is used, the bot sends the response twice — once via streaming and once via ctx.reply. Find where this happens and explain the root cause. Show me the exact code paths.'
);

// ============================================================  
// Task 3: Can MOZI create a tool for itself?
// ============================================================
console.log('\n\n### TEST 3: Self-Evolution — Can MOZI create a new tool?\n');

const r3 = await sendTask(
  'Create a new tool called "count_lines" that counts the number of lines in a file. It should take a "path" parameter (relative to workspace) and return the line count. Use bash. Test it by counting lines in workspace/SOUL.md after creating it.'
);

// ============================================================
// Task 4: Can MOZI write a fix for a real issue?
// ============================================================
console.log('\n\n### TEST 4: Self-Repair — Can MOZI fix a real bug?\n');

const r4 = await sendTask(
  'Read workspace/SOUL.md. The "What Makes You Different" section lists capabilities, but it doesn\'t mention that you can create your own tools at runtime. Add a bullet point about self-tool-creation to that section. Use edit_file to make the change precisely.'
);

// ============================================================
// Summary
// ============================================================
console.log('\n\n### SUMMARY\n');
const tests = [
  { name: 'Self-Awareness (read own code)', pass: r1 && r1.includes('replyWithHandlerResult') },
  { name: 'Bug Detection (find streaming bug)', pass: r2 && (r2.includes('duplicate') || r2.includes('twice') || r2.includes('ctx.reply')) },
  { name: 'Self-Evolution (create tool)', pass: r3 && (r3.includes('count_lines') || r3.includes('created')) },
  { name: 'Self-Repair (edit own config)', pass: r4 && (r4.includes('edit') || r4.includes('updated') || r4.includes('added')) },
];

tests.forEach(t => console.log(`[${t.pass ? 'PASS' : 'FAIL'}] ${t.name}`));
const passed = tests.filter(t => t.pass).length;
console.log(`\nResult: ${passed}/${tests.length} passed`);

process.exit(passed === tests.length ? 0 : 1);
