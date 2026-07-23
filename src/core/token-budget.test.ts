import { describe, it, expect, beforeEach } from 'vitest';
import {
  setWindowSize, getWindowSize, update, getZoneUsage, getAllUsage,
  getTotalUsage, getUsagePercent, getWatermark,
  getRemaining, reset,
} from './token-budget.js';

beforeEach(() => {
  reset();
  setWindowSize(200000);
});

describe('core/token-budget', () => {
  it('setWindowSize and getWindowSize', () => {
    setWindowSize(100000);
    expect(getWindowSize()).toBe(100000);
  });

  it('update sets zone values', () => {
    update({ system: 1000, memory: 2000, dialogue: 3000 });
    expect(getZoneUsage('system')).toBe(1000);
    expect(getZoneUsage('memory')).toBe(2000);
    expect(getZoneUsage('dialogue')).toBe(3000);
    expect(getZoneUsage('tasks')).toBe(0);
    expect(getZoneUsage('workspace')).toBe(0);
  });

  it('getTotalUsage sums all zones', () => {
    update({ system: 10000, memory: 20000, tasks: 30000, dialogue: 40000, workspace: 10000 });
    expect(getTotalUsage()).toBe(110000);
  });

  it('getUsagePercent returns correct percentage', () => {
    setWindowSize(100000);
    update({ system: 25000, dialogue: 25000 });
    expect(getUsagePercent()).toBeCloseTo(0.5);
  });

  it('getWatermark returns normal below 70%', () => {
    setWindowSize(200000);
    update({ dialogue: 100000 }); // 50%
    expect(getWatermark()).toBe('normal');
  });

  it('getWatermark returns soft at 70-85%', () => {
    setWindowSize(200000);
    update({ system: 16000, memory: 20000, tasks: 30000, dialogue: 80000, workspace: 10000 }); // 78%
    expect(getWatermark()).toBe('soft');
  });

  it('getWatermark returns hard at 85-95%', () => {
    setWindowSize(200000);
    update({ system: 16000, memory: 20000, tasks: 30000, dialogue: 80000, workspace: 30000 }); // 88%
    expect(getWatermark()).toBe('hard');
  });

  it('getWatermark returns rotate at 95%+', () => {
    setWindowSize(200000);
    update({ system: 20000, memory: 30000, tasks: 40000, dialogue: 80000, workspace: 25000 }); // 97.5%
    expect(getWatermark()).toBe('rotate');
  });

  it('getRemaining returns available tokens', () => {
    setWindowSize(100000);
    update({ dialogue: 30000 });
    expect(getRemaining()).toBe(70000);
  });

  it('reset clears all usage', () => {
    update({ system: 10000, dialogue: 20000 });
    reset();
    expect(getTotalUsage()).toBe(0);
    expect(getAllUsage()).toEqual({ system: 0, memory: 0, tasks: 0, dialogue: 0, workspace: 0 });
  });
});
