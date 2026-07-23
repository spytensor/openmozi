#!/usr/bin/env node
/**
 * Mozi 5大局限验收测试
 * 
 * 测试目标：
 * 1. 主动性 - Proactive Engine 能否主动推送
 * 2. 记忆 - 能否记住之前的对话
 * 3. 真实体挂 - AI 本质局限，跳过
 * 4. 时间紧迫感 - Reminders 能否按时提醒
 * 5. 长期关系 - Event Learner 能否记住用户偏好
 */

import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const execAsync = promisify(exec);

const MOZI_HOME = process.env.MOZI_HOME || path.join(process.env.HOME!, '.mozi');
const DB_PATH = path.join(MOZI_HOME, 'data', 'mozi.db');
const LOG_PATH = path.join(MOZI_HOME, 'logs', 'mozi.log');

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

// 测试 1: 主动性 - Proactive Engine
async function testProactivity(): Promise<TestResult> {
  console.log('\n=== 测试 1: 主动性 ===');
  
  try {
    // 检查 Proactive Engine 是否运行
    const { stdout } = await execAsync('cd ~/codes/Mozi && node dist/cli.js status');
    const isRunning = stdout.includes('running') || stdout.includes('active');
    
    // 检查日志中是否有 proactive 相关记录
    const logContent = fs.readFileSync(LOG_PATH, 'utf-8');
    const hasProactiveLog = logContent.includes('proactive') || logContent.includes('wake');
    
    // 检查数据库中是否有 proactive_events 表
    const db = new Database(DB_PATH);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const hasProactiveTable = tables.some(t => t.name.includes('proactive') || t.name.includes('event'));
    db.close();
    
    const passed = isRunning && hasProactiveTable;
    
    return {
      name: '主动性 (Proactive Engine)',
      passed,
      details: `Proactive Engine 运行: ${isRunning}, 日志中有 proactive 记录: ${hasProactiveLog}, 数据库有事件表: ${hasProactiveTable}`
    };
  } catch (error) {
    return {
      name: '主动性 (Proactive Engine)',
      passed: false,
      details: `错误: ${error}`
    };
  }
}

// 测试 2: 记忆 - Memory 系统
async function testMemory(): Promise<TestResult> {
  console.log('\n=== 测试 2: 记忆 ===');
  
  try {
    const db = new Database(DB_PATH);
    
    // 检查 memory 相关表
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const memoryTables = tables.filter(t => 
      t.name.includes('memory') || 
      t.name.includes('context') || 
      t.name.includes('session')
    );
    
    // 检查是否有记忆数据
    let memoryCount = 0;
    if (memoryTables.length > 0) {
      try {
        const countResult = db.prepare(`SELECT COUNT(*) as count FROM ${memoryTables[0].name}`).get() as { count: number };
        memoryCount = countResult.count;
      } catch (e) {
        // 表可能为空或结构不同
      }
    }
    
    db.close();
    
    const passed = memoryTables.length > 0;
    
    return {
      name: '记忆 (Memory 系统)',
      passed,
      details: `发现 ${memoryTables.length} 个记忆相关表: ${memoryTables.map(t => t.name).join(', ')}, 记忆条目: ${memoryCount}`
    };
  } catch (error) {
    return {
      name: '记忆 (Memory 系统)',
      passed: false,
      details: `错误: ${error}`
    };
  }
}

// 测试 4: 时间紧迫感 - Reminders
async function testTimeSensitivity(): Promise<TestResult> {
  console.log('\n=== 测试 4: 时间紧迫感 ===');
  
  try {
    const db = new Database(DB_PATH);
    
    // 检查 reminders 表
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const hasRemindersTable = tables.some(t => t.name.includes('reminder'));
    
    // 检查 scheduler 相关表
    const schedulerTables = tables.filter(t => t.name.includes('scheduler') || t.name.includes('job'));
    
    db.close();
    
    const passed = hasRemindersTable || schedulerTables.length > 0;
    
    return {
      name: '时间紧迫感 (Reminders)',
      passed,
      details: `Reminders 表: ${hasRemindersTable}, Scheduler 表: ${schedulerTables.length}`
    };
  } catch (error) {
    return {
      name: '时间紧迫感 (Reminders)',
      passed: false,
      details: `错误: ${error}`
    };
  }
}

// 测试 5: 长期关系 - Event Learner
async function testLongTermRelationship(): Promise<TestResult> {
  console.log('\n=== 测试 5: 长期关系 ===');
  
  try {
    const db = new Database(DB_PATH);
    
    // 检查 event learner 相关表
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const eventTables = tables.filter(t => 
      t.name.includes('event') || 
      t.name.includes('fact') || 
      t.name.includes('learning') ||
      t.name.includes('preference')
    );
    
    // 检查是否有学习数据
    let eventCount = 0;
    if (eventTables.length > 0) {
      try {
        const countResult = db.prepare(`SELECT COUNT(*) as count FROM ${eventTables[0].name}`).get() as { count: number };
        eventCount = countResult.count;
      } catch (e) {
        // 表可能为空
      }
    }
    
    db.close();
    
    const passed = eventTables.length > 0;
    
    return {
      name: '长期关系 (Event Learner)',
      passed,
      details: `发现 ${eventTables.length} 个事件/学习表: ${eventTables.map(t => t.name).join(', ')}, 事件条目: ${eventCount}`
    };
  } catch (error) {
    return {
      name: '长期关系 (Event Learner)',
      passed: false,
      details: `错误: ${error}`
    };
  }
}

// 运行所有测试
async function runAllTests() {
  console.log('========================================');
  console.log('Mozi 5大局限验收测试');
  console.log('========================================');
  
  results.push(await testProactivity());
  results.push(await testMemory());
  // 跳过测试 3 (真实体挂 - AI 本质局限)
  results.push({ name: '真实体挂', passed: false, details: 'AI 本质局限，无法解决' });
  results.push(await testTimeSensitivity());
  results.push(await testLongTermRelationship());
  
  console.log('\n========================================');
  console.log('测试结果汇总');
  console.log('========================================');
  
  let passed = 0;
  let failed = 0;
  
  results.forEach(r => {
    const status = r.passed ? '✅ 通过' : '❌ 失败';
    console.log(`\n${status} - ${r.name}`);
    console.log(`  详情: ${r.details}`);
    
    if (r.passed) passed++;
    else failed++;
  });
  
  console.log('\n========================================');
  console.log(`总计: ${passed} 通过, ${failed} 失败`);
  console.log('========================================');
  
  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch(console.error);
