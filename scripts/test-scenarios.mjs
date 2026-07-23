/**
 * E2E Scenario Tests — Simulates user messages through MOZI's gateway handler
 * Tests real LLM calls, tool execution, memory, search
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Bootstrap: load config and DB like index.ts does
process.env.DOTENV_CONFIG_PATH = resolve('.env');
import 'dotenv/config';

const { loadConfig, getConfig } = await import('./dist/config/index.js');
const { initDb } = await import('./dist/store/db.js');
const { handleMessage } = await import('./dist/gateway/handler.js');
const { create } = await import('./dist/core/llm.js');

// Init
loadConfig();
const config = getConfig();
// Use the existing production DB (read-write, separate chat ID for isolation)
const dbPath = resolve('data', 'mozi.db');
initDb(dbPath);

// Create LLM client
const client = create('openai', { model: 'gpt-4.1-mini' });

// System prompt
const soulPath = resolve('workspace', 'SOUL.md');
const systemPrompt = readFileSync(soulPath, 'utf-8');

// Progress stub
const progress = {
  onProcessingStart: () => {},
  onToolStart: (n) => console.log(`  [tool_start] ${n}`),
  onToolEnd: (n) => console.log(`  [tool_end] ${n}`),
  onStreamChunk: () => {},
  onStreamEnd: () => {},
};

const TEST_CHAT = 'e2e_test_' + Date.now();
const results = [];

async function test(name, userMsg, validate) {
  console.log(`\n--- Test: ${name} ---`);
  console.log(`  [user] ${userMsg}`);
  
  const msg = {
    channelType: 'telegram',
    chatId: TEST_CHAT,
    userId: 'test_user',
    username: 'tester',
    text: userMsg,
    isCommand: false,
    timestamp: new Date(),
  };

  try {
    const response = await handleMessage(msg, systemPrompt, client, progress);
    console.log(`  [assistant] ${response?.slice(0, 200)}${response?.length > 200 ? '...' : ''}`);
    
    const pass = validate(response);
    console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
    results.push({ name, pass, response: response?.slice(0, 100) });
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
    results.push({ name, pass: false, response: err.message });
  }
}

// ===== Scenario 1: Basic conversation =====
await test(
  'Basic greeting',
  'Hello, who are you?',
  (r) => r && r.toLowerCase().includes('mozi')
);

// ===== Scenario 2: Tool use — list files =====
await test(
  'List workspace files',
  'List the files in workspace directory',
  (r) => r && (r.includes('SOUL') || r.includes('AGENTS') || r.includes('test.txt'))
);

// ===== Scenario 3: Tool use — write and read file =====
await test(
  'Write and read file',
  'Create a file workspace/e2e-test.md with content "# E2E Test\\nThis was created by MOZI." then read it back to confirm.',
  (r) => r && r.includes('E2E Test')
);

// ===== Scenario 4: Web search =====
await test(
  'Web search',
  'Search the web for "TypeScript 5.8 release date"',
  (r) => r && (r.includes('TypeScript') || r.includes('typescript') || r.includes('http'))
);

// ===== Scenario 5: Remember a fact =====
await test(
  'Remember preference',
  'Remember that my favorite programming language is Rust',
  (r) => r && (r.includes('remember') || r.includes('noted') || r.includes('stored') || r.includes('Rust'))
);

// ===== Scenario 6: Recall the fact =====
await test(
  'Recall preference',
  'What is my favorite programming language?',
  (r) => r && r.toLowerCase().includes('rust')
);

// ===== Scenario 7: Edit file =====
await test(
  'Edit file',
  'Edit workspace/e2e-test.md and change "E2E Test" to "E2E Test PASSED"',
  (r) => r && (r.includes('PASSED') || r.includes('edited') || r.includes('changed') || r.includes('replaced'))
);

// ===== Scenario 8: Set reminder =====
await test(
  'Set reminder',
  'Set a reminder in 2 minutes to check the test results',
  (r) => r && (r.includes('reminder') || r.includes('Reminder') || r.includes('set') || r.includes('minutes'))
);

// ===== Scenario 9: Learn a lesson =====
await test(
  'Learn lesson',
  "Don't ever use var in JavaScript, always use const or let. Learn this lesson.",
  (r) => r && (r.includes('lesson') || r.includes('learn') || r.includes('noted') || r.includes('const'))
);

// ===== Summary =====
console.log('\n\n========== RESULTS ==========');
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;
console.log(`Total: ${results.length} | PASS: ${passed} | FAIL: ${failed}`);
results.forEach(r => console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`));

if (failed > 0) {
  console.log('\nFailed tests:');
  results.filter(r => !r.pass).forEach(r => console.log(`  ${r.name}: ${r.response}`));
}

// Cleanup
const { unlinkSync } = await import('fs');
// Don't delete production DB
try { unlinkSync(resolve('workspace', 'e2e-test.md')); } catch {}

process.exit(failed > 0 ? 1 : 0);
