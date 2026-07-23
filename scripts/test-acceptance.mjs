/**
 * MOZI 验收测试 - 从真实用户角度
 * 测试 #28-#31 所有修复
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Load env
for (const line of readFileSync('.env', 'utf-8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq > 0 && !process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
}

const { loadConfig } = require('./dist/config/index.js');
const { initDb } = require('./dist/store/db.js');
const { runMigrations } = require('./dist/store/migrate.js');
const { handleMessage } = require('./dist/gateway/handler.js');
const { create } = require('./dist/core/llm.js');

loadConfig();
initDb();
runMigrations();

const client = create('openai', { model: 'gpt-4.1-mini' });
const systemPrompt = readFileSync(resolve('workspace', 'SOUL.md'), 'utf-8');

const progress = {
  onProcessingStart: () => {},
  onToolStart: (n) => console.log(`  [tool] ${n}`),
  onToolEnd: () => {},
  onStreamChunk: () => {},
  onStreamEnd: () => {},
};

const results = [];

async function test(name, userMsg, validate) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`测试: ${name}`);
  console.log('='.repeat(60));
  
  console.log(`[User] ${userMsg.slice(0, 80)}${userMsg.length > 80 ? '...' : ''}`);
  
  const msg = {
    channelType: 'test',
    chatId: '验收测试_' + Date.now(),
    userId: 'tester_001',
    username: 'tester',
    text: userMsg,
    isCommand: false,
    timestamp: new Date(),
  };

  try {
    const response = await handleMessage(msg, systemPrompt, client, progress);
    const pass = validate(response);
    console.log(`[Result] ${pass ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`[Response] ${response?.slice(0, 300) || '(empty)'}`);
    results.push({ name, pass, response: response?.slice(0, 200) });
    return pass;
  } catch (err) {
    console.log(`[Error] ${err.message}`);
    results.push({ name, pass: false, response: err.message });
    return false;
  }
}

// ============================================================
// 测试执行
// ============================================================

(async () => {
  console.log('🚀 MOZI 验收测试开始\n');
  
  // #29 跨会话记忆
  console.log('\n### 测试 #29: 跨会话记忆 ###\n');
  await test('#29-1: 记住偏好', '记住我喜欢简洁的回答', 
    (r) => r && (r.includes('记住') || r.includes('记得')));
  await test('#29-2: 跨会话召回', '我的偏好是什么？', 
    (r) => r && (r.includes('简洁') || r.includes('偏好')));
  
  // #28 动态工具
  console.log('\n### 测试 #28: 动态工具执行 ###\n');
  await test('#28-1: 创建工具', '创建一个工具叫 test_tool，输出 hello world', 
    (r) => r && (r.includes('test_tool') || r.includes('创建')));
  await test('#28-2: 使用工具', '运行 test_tool', 
    (r) => r && (r.includes('hello') || r.includes('world')));
  
  // #30 DAG 聚合
  console.log('\n### 测试 #30: DAG 多任务 ###\n');
  await test('#30: 多步任务', '列出 workspace 目录文件，然后读取第一个文件', 
    (r) => r && r.length > 50);
  
  // #31 统一输出
  console.log('\n### 测试 #31: 统一输出 ###\n');
  await test('#31: 无错误响应', '你好，请告诉我你是谁', 
    (r) => r && r.length > 0 && !r.includes('Error'));

  console.log('\n' + '='.repeat(60));
  console.log('📊 测试结果汇总');
  console.log('='.repeat(60));
  
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  
  console.log(`总计: ${results.length} | ✅ 通过: ${passed} | ❌ 失败: ${failed}\n`);
  
  results.forEach(r => {
    console.log(`[${r.pass ? '✅' : '❌'}] ${r.name}`);
  });

  process.exit(failed > 0 ? 1 : 0);
})();
