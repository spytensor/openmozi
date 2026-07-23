import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const domainRoutes = {
  'memory-routes.ts': [
    'GET /api/memory/facts',
    'GET /api/memory/search',
    'DELETE /api/memory/facts/:id',
    'PATCH /api/memory/facts/:id',
    'PATCH /api/memory/facts/:id/status',
    'POST /api/memory/facts',
    'GET /api/memory/status',
    'GET /api/memory/export',
    'DELETE /api/memory/facts',
    'GET /api/memory/digests',
  ],
  'office-routes.ts': [
    'GET /api/office/session',
    'GET /api/office/file',
  ],
  'scheduler-routes.ts': [
    'GET /api/scheduler/tasks',
    'POST /api/scheduler/tasks',
    'PATCH /api/scheduler/tasks/:id',
    'POST /api/scheduler/tasks/:id/run-now',
    'DELETE /api/scheduler/tasks/:id',
    'GET /api/scheduler/reminders',
    'POST /api/scheduler/reminders',
    'DELETE /api/scheduler/reminders/:id',
  ],
  'task-template-routes.ts': [
    'GET /api/task-templates',
    'POST /api/task-templates',
    'PUT /api/task-templates/reorder',
    'GET /api/task-templates/:id',
    'PUT /api/task-templates/:id',
    'DELETE /api/task-templates/:id',
  ],
} as const;

function registeredRoutes(source: string): string[] {
  return [...source.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/g)]
    .map(([, method, path]) => `${method.toUpperCase()} ${path}`);
}

describe('domain route inventory', () => {
  it('keeps the public API entrypoint free of route implementations', () => {
    const rootSource = readFileSync(new URL('../api-routes.ts', import.meta.url), 'utf8');
    expect(rootSource.split('\n').length).toBeLessThan(20);
    expect(registeredRoutes(rootSource)).toEqual([]);
  });

  it('registers each extracted route exactly once and outside the root orchestrator', () => {
    const rootSource = readFileSync(new URL('../api-routes.ts', import.meta.url), 'utf8');
    const allRoutes: string[] = [];

    for (const [filename, expected] of Object.entries(domainRoutes)) {
      const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
      const actual = registeredRoutes(source);
      expect(actual).toEqual(expected);
      allRoutes.push(...actual);

      for (const route of expected) {
        const path = route.slice(route.indexOf(' ') + 1);
        expect(rootSource).not.toContain(`'${path}'`);
      }
    }

    expect(new Set(allRoutes).size).toBe(allRoutes.length);
  });
});
