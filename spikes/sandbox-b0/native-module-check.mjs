import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const stageNative = path.join(here, 'stage', 'native');
const sqliteNative = path.join(stageNative, 'better_sqlite3.node');
const lanceNative = path.join(stageNative, 'lancedb.darwin-arm64.node');

process.env.NAPI_RS_NATIVE_LIBRARY_PATH = lanceNative;

const { default: Database } = await import('better-sqlite3');
const lancedb = await import('@lancedb/lancedb');

const tempRoot = mkdtempSync(path.join(tmpdir(), 'mozi-b0-native-'));
const sqlitePath = path.join(tempRoot, 'sqlite', 'probe.db');
const lanceDir = path.join(tempRoot, 'lance');

try {
  mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const sqlite = new Database(sqlitePath, { nativeBinding: sqliteNative });
  sqlite.exec('create table probe (id integer primary key, label text not null)');
  sqlite.prepare('insert into probe (label) values (?)').run('signed-native-ok');
  const row = sqlite.prepare('select id, label from probe').get();
  sqlite.close();

  const conn = await lancedb.connect(lanceDir);
  const table = await conn.createTable('items', [
    { id: 1, vector: [0.1, 0.2, 0.3], text: 'signed-native-ok' },
    { id: 2, vector: [0.2, 0.3, 0.4], text: 'second' },
  ]);
  const tableNames = await conn.tableNames();
  const rows = await table.query().limit(2).toArray();

  console.log(JSON.stringify({
    status: 'ok',
    node: process.execPath,
    modules: process.versions.modules,
    sqliteNative,
    sqliteRow: row,
    lanceNative: process.env.NAPI_RS_NATIVE_LIBRARY_PATH,
    lanceTables: tableNames,
    lanceRowCount: rows.length,
    tempRoot,
    repoRoot,
  }, null, 2));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
