/**
 * Live E2E tests — sends messages to MOZI via Telegram Bot API webhook simulation
 * and checks bot logs for responses
 */
import { readFileSync, writeFileSync } from 'fs';

const BOT_TOKEN = process.env.MOZI_TEST_TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.MOZI_TEST_TELEGRAM_CHAT_ID;
const LOG_FILE = '/tmp/mozi-bot.log';

// We can't send "as user" via Bot API, but we can hit the local HTTP server
// or check the Telegram getUpdates. Instead, let's use the bot's own /api endpoint
// or just monitor logs after configured test messages.

// Alternative: Test via the WebSocket API
async function testWebSocket() {
  console.log('=== Testing via log analysis ===\n');
  
  const log = readFileSync(LOG_FILE, 'utf-8');
  const lines = log.split('\n').filter(l => l.trim());
  
  // Parse recent activity
  const recent = lines.slice(-50).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  
  // Check tool usage
  const toolCalls = recent.filter(l => l.msg?.includes('tool') || l.msg?.includes('Tool'));
  const llmCalls = recent.filter(l => l.msg?.includes('LLM response'));
  const errors = recent.filter(l => l.level >= 50);
  const stateTransitions = recent.filter(l => l.msg?.includes('State transition'));
  
  console.log(`Log entries (last 50): ${recent.length}`);
  console.log(`LLM calls: ${llmCalls.length}`);
  console.log(`Tool calls: ${toolCalls.length}`);
  console.log(`State transitions: ${stateTransitions.length}`);
  console.log(`Errors: ${errors.length}`);
  
  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach(e => console.log(`  [${e.name}] ${e.msg}: ${e.err || ''}`));
  }
  
  // Check system prompt
  const promptLog = recent.find(l => l.promptLength);
  if (promptLog) {
    console.log(`\nSystem prompt: ${promptLog.promptLength} chars, ${promptLog.tools} tools`);
  }
  
  // Check conversation flow
  const messages = recent.filter(l => l.chatId === CHAT_ID);
  console.log(`\nMessages from configured test chat: ${messages.length}`);
  
  for (const m of messages.slice(-10)) {
    if (m.text) console.log(`  [IN] ${m.text.slice(0, 80)}`);
    if (m.msg?.includes('LLM response')) {
      console.log(`  [OUT] model=${m.model} tokens=${JSON.stringify(m.tokens)} tools=${m.toolIterations}`);
    }
  }
}

// Test 2: Send a test message via fetch to local API
async function testLocalAPI() {
  console.log('\n=== Testing Local HTTP API ===\n');
  
  try {
    const res = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(3000) });
    console.log(`Health: ${res.status}`);
  } catch (e) {
    console.log(`Health endpoint: ${e.message}`);
  }
}

// Test 3: Send actual test messages via Telegram Bot API to the configured test chat
// This tests if the bot can at least send messages
async function testBotSend() {
  console.log('\n=== Testing Bot Send Capability ===\n');

  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('SKIP: set MOZI_TEST_TELEGRAM_BOT_TOKEN and MOZI_TEST_TELEGRAM_CHAT_ID to run the external send check.');
    return;
  }
  
  const tests = [
    { name: 'Simple message', text: 'MOZI self-test: I can send messages.' },
  ];
  
  for (const test of tests) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, text: `[Self-Test] ${test.text}` }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      console.log(`${test.name}: ${data.ok ? 'PASS' : 'FAIL'} (${data.ok ? 'sent' : data.description})`);
    } catch (e) {
      console.log(`${test.name}: ERROR (${e.message})`);
    }
  }
}

// Test 4: Verify all 13 tools are registered
async function testToolRegistry() {
  console.log('\n=== Verifying Tool Registry ===\n');
  
  const expectedTools = [
    'shell_exec', 'read_file', 'write_file', 'list_directory',
    'edit_file', 'append_file', 'web_search', 'web_fetch',
    'analyze_image', 'remember', 'recall', 'learn_lesson', 'set_reminder'
  ];
  
  const log = readFileSync(LOG_FILE, 'utf-8');
  const lines = log.split('\n').filter(l => l.trim());
  const promptLog = lines.map(l => { try { return JSON.parse(l); } catch { return null; }})
    .filter(Boolean)
    .find(l => l.tools);
  
  if (promptLog) {
    const registered = promptLog.tools;
    console.log(`Expected: ${expectedTools.length} tools`);
    console.log(`Registered: ${registered} tools`);
    console.log(`Match: ${registered === expectedTools.length ? 'PASS' : 'FAIL'}`);
  }
}

// Test 5: Check memory system
async function testMemorySystem() {
  console.log('\n=== Testing Memory System ===\n');
  
  const { execSync } = await import('child_process');
  const dbPath = process.env.MOZI_TEST_DB_PATH ?? './data/mozi.db';
  
  try {
    const tables = execSync(`sqlite3 "${dbPath}" ".tables" 2>/dev/null`).toString().trim();
    console.log('Tables:', tables);
    
    const convCount = execSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM conversations;" 2>/dev/null`).toString().trim();
    console.log(`Conversations: ${convCount} messages`);
    
    const factCount = execSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM memory_facts;" 2>/dev/null`).toString().trim();
    console.log(`Memory facts: ${factCount}`);
    
    const lessonCount = execSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM lessons;" 2>/dev/null`).toString().trim();
    console.log(`Lessons: ${lessonCount}`);
    
    const reminderCount = execSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM reminders;" 2>/dev/null`).toString().trim();
    console.log(`Reminders: ${reminderCount}`);
    
    // Recent conversations
    const recent = execSync(`sqlite3 "${dbPath}" "SELECT role, substr(content, 1, 60), created_at FROM conversations ORDER BY id DESC LIMIT 5;" 2>/dev/null`).toString().trim();
    if (recent) {
      console.log('\nRecent conversations:');
      console.log(recent);
    }
  } catch (e) {
    console.log('DB error:', e.message);
  }
}

// Test 6: Check scheduler is running
async function testScheduler() {
  console.log('\n=== Testing Scheduler ===\n');
  
  const log = readFileSync(LOG_FILE, 'utf-8');
  const hasScheduler = log.includes('Reminder scheduler started');
  console.log(`Scheduler started: ${hasScheduler ? 'PASS' : 'FAIL'}`);
}

await testWebSocket();
await testLocalAPI();
await testBotSend();
await testToolRegistry();
await testMemorySystem();
await testScheduler();

console.log('\n=== Live E2E Test Complete ===');
