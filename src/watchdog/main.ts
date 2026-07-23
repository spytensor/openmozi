#!/usr/bin/env node
/**
 * Watchdog Main — Standalone entry point for the MOZI watchdog process.
 *
 * Run independently: node dist/watchdog/main.js
 * Or via pnpm: pnpm watchdog
 *
 * Environment variables:
 *   MOZI_HEARTBEAT_PATH  — path to heartbeat file (default: data/heartbeat.json)
 *   MOZI_WATCHDOG_INTERVAL — check interval in ms (default: 5000)
 *   MOZI_WATCHDOG_THRESHOLD — stale threshold in ms (default: 15000)
 *   TELEGRAM_BOT_TOKEN — Telegram bot token for notifications
 *   TELEGRAM_CHAT_ID — Telegram chat ID for notifications
 */

import { createWatchdog } from './index.js';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const heartbeatPath = process.env.MOZI_HEARTBEAT_PATH ?? join('data', 'heartbeat.json');
const checkIntervalMs = Number(process.env.MOZI_WATCHDOG_INTERVAL) || 5000;
const staleThresholdMs = Number(process.env.MOZI_WATCHDOG_THRESHOLD) || 15000;
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
const mainProcessEntry = process.env.MOZI_MAIN_ENTRY ?? 'dist/index.js';

console.log('[watchdog] Starting MOZI watchdog');
console.log(`[watchdog] Heartbeat file: ${heartbeatPath}`);
console.log(`[watchdog] Check interval: ${checkIntervalMs}ms`);
console.log(`[watchdog] Stale threshold: ${staleThresholdMs}ms`);

const watchdog = createWatchdog({
  heartbeatPath,
  checkIntervalMs,
  staleThresholdMs,
  telegramBotToken,
  telegramChatId,
  mainProcessEntry,
});

// Override the default check to actually spawn a new process on restart
const originalCheckOnce = watchdog.checkOnce;
const wrappedCheckOnce = async () => {
  const result = await originalCheckOnce();
  if (result.stale && result.action) {
    // Spawn the main process
    console.log(`[watchdog] Restarting main process: node ${mainProcessEntry}`);
    const child = spawn('node', [mainProcessEntry], {
      stdio: 'inherit',
      detached: true,
    });
    child.unref();
    console.log(`[watchdog] Spawned new main process with PID: ${child.pid}`);
  }
  return result;
};

// Replace checkOnce on the interval
const intervalId = setInterval(async () => {
  try {
    const result = await wrappedCheckOnce();
    if (result.stale) {
      console.log(`[watchdog] Heartbeat stale (age: ${result.age}ms), action: ${result.action}`);
    }
  } catch (err) {
    console.error('[watchdog] Check failed:', err);
  }
}, checkIntervalMs);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[watchdog] Received SIGTERM, shutting down');
  clearInterval(intervalId);
  watchdog.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[watchdog] Received SIGINT, shutting down');
  clearInterval(intervalId);
  watchdog.stop();
  process.exit(0);
});

console.log('[watchdog] Watchdog running. Press Ctrl+C to stop.');
