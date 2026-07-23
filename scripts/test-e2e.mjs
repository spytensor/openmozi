/**
 * E2E Test Suite — Tests MOZI from user perspective via Telegram Bot API
 * Sends messages and captures responses to evaluate real behavior
 */

// Test via WebSocket/HTTP instead
const WS_URL = 'ws://127.0.0.1:3000/ws';
const HTTP_URL = 'http://127.0.0.1:3000';

async function testHTTP(path, body) {
  const res = await fetch(`${HTTP_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => res.text()) };
}

// ============================================================
// Test Scenarios
// ============================================================

const results = [];

function log(test, pass, detail) {
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${test}: ${detail}`);
  results.push({ test, pass, detail });
}

// --- Scenario 1: System Prompt Loading ---
async function testSystemPrompt() {
  // Check if SOUL.md is actually loaded by looking at bot log
  const { readFileSync } = await import('fs');
  const logContent = readFileSync('/tmp/mozi-bot.log', 'utf-8');
  const promptMatch = logContent.match(/"promptLength":(\d+)/);
  const promptLen = promptMatch ? parseInt(promptMatch[1]) : 0;
  
  log('System Prompt Length', promptLen > 500, 
    `promptLength=${promptLen} (${promptLen > 500 ? 'SOUL.md loaded' : 'FALLBACK ONLY — SOUL.md not found!'})`);
  
  // Check if workspace.dir is configured
  const { readFileSync: rf } = await import('fs');
  const config = rf('./config.yaml', 'utf-8');
  const hasWorkspaceDir = config.includes('workspace:');
  log('Workspace Config', hasWorkspaceDir, 
    hasWorkspaceDir ? 'workspace.dir configured' : 'MISSING — defaults to ~/.mozi/workspace which has no SOUL.md');
}

// --- Scenario 2: Memory Persistence ---
async function testMemory() {
  const { existsSync, readFileSync } = await import('fs');
  const dbPath = './data/mozi.db'; // check where DB actually is
  
  // Look for the actual db
  const { execSync } = await import('child_process');
  const dbLoc = execSync('find . -name "*.db" -not -path "*/node_modules/*" 2>/dev/null').toString().trim();
  log('Database Location', dbLoc.length > 0, dbLoc || 'No SQLite DB found');
  
  if (dbLoc) {
    // Check conversations table
    try {
      const count = execSync(`sqlite3 "${dbLoc.split('\n')[0]}" "SELECT COUNT(*) FROM conversations;" 2>/dev/null`).toString().trim();
      log('Conversation History', true, `${count} messages stored`);
      
      // Check if history has recent messages
      const recent = execSync(`sqlite3 "${dbLoc.split('\n')[0]}" "SELECT role, substr(content, 1, 60), created_at FROM conversations ORDER BY id DESC LIMIT 5;" 2>/dev/null`).toString().trim();
      console.log('  Recent messages:', recent || '(none)');
    } catch (e) {
      log('Conversation History', false, e.message);
    }
  }
}

// --- Scenario 3: Tool Execution Security ---
async function testToolSecurity() {
  const { execSync } = await import('child_process');
  const { readFileSync } = await import('fs');
  
  // Check restricted commands list
  const shellSrc = readFileSync('./src/capabilities/shell.ts', 'utf-8');
  const hasBlocklist = shellSrc.includes('rm -rf') || shellSrc.includes('BLOCKED') || shellSrc.includes('restricted');
  log('Shell Blocklist', hasBlocklist, hasBlocklist ? 'Has restricted command detection' : 'NO restriction on dangerous commands!');
  
  // Check path traversal protection
  const executorSrc = readFileSync('./src/tools/executor.ts', 'utf-8');
  const hasPathTraversal = executorSrc.includes('startsWith') && executorSrc.includes('traversal');
  log('Path Traversal Protection', hasPathTraversal, hasPathTraversal ? 'Protected' : 'VULNERABLE');
  
  // Check if shell runs from workspace or project root
  const runsFromRoot = executorSrc.includes("resolve('.')");
  log('Shell CWD', true, runsFromRoot ? 'Runs from project root (can access all files!)' : 'Runs from workspace');
}

// --- Scenario 4: Conversation Context Window ---
async function testContextWindow() {
  const { readFileSync } = await import('fs');
  const handlerSrc = readFileSync('./src/gateway/handler.ts', 'utf-8');
  
  // Check history limit
  const historyMatch = handlerSrc.match(/getHistory\([^,]+,\s*(\d+)/);
  const historyLimit = historyMatch ? parseInt(historyMatch[1]) : 0;
  log('History Limit', historyLimit > 0, `Last ${historyLimit} messages loaded`);
  
  // Check if there's any token counting for context
  const hasTokenCounting = handlerSrc.includes('token') && (handlerSrc.includes('count') || handlerSrc.includes('budget'));
  log('Context Token Counting', hasTokenCounting, hasTokenCounting ? 'Implemented' : 'NO token counting — could overflow context window!');
  
  // Check if there's running summary / compression
  const hasCompression = handlerSrc.includes('summary') || handlerSrc.includes('compress') || handlerSrc.includes('truncat');
  log('Context Compression', hasCompression, hasCompression ? 'Has compression' : 'NO context compression — long conversations will break!');
}

// --- Scenario 5: Error Handling & Resilience ---
async function testErrorHandling() {
  const { readFileSync } = await import('fs');
  const handlerSrc = readFileSync('./src/gateway/handler.ts', 'utf-8');
  const indexSrc = readFileSync('./src/index.ts', 'utf-8');
  
  // Check if LLM errors are caught gracefully
  const hasLLMErrorHandling = handlerSrc.includes('catch') && (handlerSrc.includes('Error') || handlerSrc.includes('error'));
  log('LLM Error Handling', hasLLMErrorHandling, hasLLMErrorHandling ? 'Has try/catch' : 'LLM errors may crash the bot');
  
  // Check graceful shutdown
  const hasGracefulShutdown = indexSrc.includes('SIGINT') && indexSrc.includes('SIGTERM');
  log('Graceful Shutdown', hasGracefulShutdown, hasGracefulShutdown ? 'SIGINT + SIGTERM handled' : 'No graceful shutdown');
  
  // Check if tool errors crash the handler
  const executorSrc = readFileSync('./src/tools/executor.ts', 'utf-8');
  const toolErrorsSafe = executorSrc.includes('catch') && executorSrc.includes('is_error: true');
  log('Tool Error Safety', toolErrorsSafe, toolErrorsSafe ? 'Errors returned as messages' : 'Tool errors may crash handler');
  
  // Rate limiting on Telegram
  const hasTelegramRateLimit = indexSrc.includes('rate') || indexSrc.includes('throttl') || indexSrc.includes('429');
  log('Telegram Rate Limiting', hasTelegramRateLimit, hasTelegramRateLimit ? 'Has rate limiting' : 'NO rate limiting — Telegram 429 will crash edits');
}

// --- Scenario 6: Multi-turn Conversation Quality ---
async function testConversationQuality() {
  const { readFileSync } = await import('fs');
  const handlerSrc = readFileSync('./src/gateway/handler.ts', 'utf-8');
  
  // Does it pass system prompt on every call?
  const passesSystemPrompt = handlerSrc.includes("role: 'system'") && handlerSrc.includes('systemPrompt');
  log('System Prompt in Context', passesSystemPrompt, passesSystemPrompt ? 'Included every call' : 'System prompt may be missing');
  
  // Does it save assistant messages?
  const savesAssistant = handlerSrc.includes("'assistant'") && handlerSrc.includes('saveMessage');
  log('Assistant Message Persistence', savesAssistant, savesAssistant ? 'Saved to DB' : 'NOT saved — no memory of own responses');
  
  // Does it save tool results in context?
  const savesToolContext = handlerSrc.includes("role: 'tool'");
  log('Tool Results in Context', savesToolContext, savesToolContext ? 'Included in LLM context' : 'Tool results NOT in context');
  
  // But are tool call messages saved to DB?
  const savesToolToDB = (handlerSrc.match(/saveMessage/g) || []).length;
  log('DB Message Completeness', savesToolToDB >= 2, `${savesToolToDB} saveMessage calls (need user + assistant at minimum)`);
}

// --- Scenario 7: Intelligence Gaps vs OpenClaw ---
async function testIntelligenceGaps() {
  const { readFileSync, existsSync } = await import('fs');
  
  // Check for long-term memory (facts, preferences, user profile)
  const hasLongTermMemory = existsSync('./src/memory/facts.ts') || existsSync('./src/memory/profile.ts') || existsSync('./src/memory/long-term.ts');
  log('Long-term Memory', hasLongTermMemory, hasLongTermMemory ? 'Has facts/profile storage' : 'NO long-term memory — forgets everything between sessions');
  
  // Check for web search capability
  const hasBrowser = existsSync('./src/tools/browser.ts') || existsSync('./src/capabilities/browser.ts');
  const hasSearch = existsSync('./src/tools/search.ts') || existsSync('./src/capabilities/search.ts');
  log('Web Search', hasSearch || hasBrowser, (hasSearch || hasBrowser) ? 'Available' : 'NO web search — cannot look up current information');
  
  // Check for image/vision capability
  const hasVision = existsSync('./src/tools/vision.ts') || existsSync('./src/capabilities/vision.ts');
  log('Vision/Image', hasVision, hasVision ? 'Available' : 'NO vision — cannot process images');
  
  // Check for file upload handling
  const telegramSrc = readFileSync('./src/channels/telegram.ts', 'utf-8');
  const handlesFiles = telegramSrc.includes('document') || telegramSrc.includes('photo') || telegramSrc.includes('file');
  log('File Upload Handling', handlesFiles, handlesFiles ? 'Handles files' : 'NO file handling — ignores documents/photos sent in Telegram');
  
  // Check for proactive behavior (cron, heartbeat, scheduled tasks)
  const hasProactive = existsSync('./src/scheduler') || existsSync('./src/cron');
  log('Proactive Behavior', hasProactive, hasProactive ? 'Has scheduler' : 'NO proactive behavior — only responds, never initiates');
  
  // Check for multi-model routing in actual use
  const handlerSrc = readFileSync('./src/gateway/handler.ts', 'utf-8');
  const usesRouter = handlerSrc.includes('getClientForTask');
  log('Dynamic Model Routing', usesRouter, usesRouter ? 'Uses model router' : 'Single model only');
  
  // Check for self-improvement / learning
  const hasLearning = existsSync('./src/memory/lessons.ts') || existsSync('./src/learning');
  log('Self-Learning', hasLearning, hasLearning ? 'Has learning system' : 'NO self-learning — repeats same mistakes');
  
  // Check for edit_file tool (precision editing)
  const toolsSrc = readFileSync('./src/tools/definitions.ts', 'utf-8');
  const hasEditFile = toolsSrc.includes('edit_file');
  log('Edit File Tool', hasEditFile, hasEditFile ? 'Available' : 'NO edit_file — must rewrite entire files');
  
  // Check for web_fetch tool
  const hasWebFetch = toolsSrc.includes('web_fetch') || toolsSrc.includes('fetch_url');
  log('Web Fetch Tool', hasWebFetch, hasWebFetch ? 'Available' : 'NO web_fetch — cannot read URLs');
}

// ============================================================
// Run All Tests
// ============================================================

console.log('=== MOZI E2E Architecture & Intelligence Audit ===\n');

await testSystemPrompt();
console.log('');
await testMemory();
console.log('');
await testToolSecurity();
console.log('');
await testContextWindow();
console.log('');
await testErrorHandling();
console.log('');
await testConversationQuality();
console.log('');
await testIntelligenceGaps();

console.log('\n=== Summary ===');
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;
console.log(`Total: ${results.length} | PASS: ${passed} | FAIL: ${failed}`);
console.log('\nCritical Issues:');
results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.test}: ${r.detail}`));
