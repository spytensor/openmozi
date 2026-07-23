import { randomUUID } from 'node:crypto';
import { getDb } from '../store/db.js';

export interface TaskTemplate {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  instructions: string;
  output_format: string;
  pinned: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TaskTemplateInput {
  title: string;
  instructions: string;
  output_format?: string;
  pinned?: boolean;
}

interface TaskTemplateRow extends Omit<TaskTemplate, 'pinned'> {
  pinned: number;
}

function mapRow(row: TaskTemplateRow): TaskTemplate {
  return { ...row, pinned: row.pinned === 1 };
}

export function listTaskTemplates(tenantId: string, userId: string): TaskTemplate[] {
  return getDb().prepare(`
    SELECT * FROM task_templates
    WHERE tenant_id = ? AND user_id = ?
    ORDER BY sort_order ASC, created_at ASC
  `).all(tenantId, userId).map(row => mapRow(row as TaskTemplateRow));
}

export function createTaskTemplate(tenantId: string, userId: string, input: TaskTemplateInput): TaskTemplate {
  const db = getDb();
  const id = randomUUID();
  const nextOrder = (db.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
    FROM task_templates WHERE tenant_id = ? AND user_id = ?
  `).get(tenantId, userId) as { next_order: number }).next_order;
  db.prepare(`
    INSERT INTO task_templates (
      id, tenant_id, user_id, title, instructions, output_format, pinned, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    tenantId,
    userId,
    input.title,
    input.instructions,
    input.output_format ?? '',
    input.pinned === false ? 0 : 1,
    nextOrder,
  );
  return getTaskTemplate(tenantId, userId, id)!;
}

export function getTaskTemplate(tenantId: string, userId: string, id: string): TaskTemplate | undefined {
  const row = getDb().prepare(`
    SELECT * FROM task_templates
    WHERE tenant_id = ? AND user_id = ? AND id = ?
  `).get(tenantId, userId, id) as TaskTemplateRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function updateTaskTemplate(
  tenantId: string,
  userId: string,
  id: string,
  input: TaskTemplateInput,
): TaskTemplate | undefined {
  const result = getDb().prepare(`
    UPDATE task_templates
    SET title = ?, instructions = ?, output_format = ?, pinned = ?, updated_at = datetime('now')
    WHERE tenant_id = ? AND user_id = ? AND id = ?
  `).run(
    input.title,
    input.instructions,
    input.output_format ?? '',
    input.pinned === false ? 0 : 1,
    tenantId,
    userId,
    id,
  );
  return result.changes === 1 ? getTaskTemplate(tenantId, userId, id) : undefined;
}

export function deleteTaskTemplate(tenantId: string, userId: string, id: string): boolean {
  return getDb().prepare(`
    DELETE FROM task_templates
    WHERE tenant_id = ? AND user_id = ? AND id = ?
  `).run(tenantId, userId, id).changes === 1;
}

export function reorderTaskTemplates(tenantId: string, userId: string, ids: string[]): TaskTemplate[] | undefined {
  const db = getDb();
  const owned = db.prepare(`
    SELECT id FROM task_templates WHERE tenant_id = ? AND user_id = ?
  `).all(tenantId, userId) as Array<{ id: string }>;
  const ownedIds = new Set(owned.map(row => row.id));
  if (ids.length !== ownedIds.size || ids.some(id => !ownedIds.has(id)) || new Set(ids).size !== ids.length) {
    return undefined;
  }
  const update = db.prepare(`
    UPDATE task_templates SET sort_order = ?, updated_at = datetime('now')
    WHERE tenant_id = ? AND user_id = ? AND id = ?
  `);
  db.transaction(() => ids.forEach((id, index) => update.run(index, tenantId, userId, id)))();
  return listTaskTemplates(tenantId, userId);
}
