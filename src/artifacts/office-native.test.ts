import { describe, expect, it } from 'vitest';
import { createNativeOfficeSession, nativeOfficeDocumentType, resolveNativeOfficeEnvironment } from './office-native.js';

describe('native Office sessions', () => {
  const env = {
    browserUrl: 'http://localhost:8082',
    internalUrl: 'http://onlyoffice',
    storageBaseUrl: 'http://mozi:9210',
    jwtSecret: 'test-office-secret',
  };

  it('maps OOXML files to the correct editor and signs a read-only config', () => {
    expect(nativeOfficeDocumentType('docx')).toBe('word');
    expect(nativeOfficeDocumentType('xlsx')).toBe('cell');
    expect(nativeOfficeDocumentType('pptx')).toBe('slide');
    const session = createNativeOfficeSession({
      path: '/data/report.xlsx', filename: 'report.xlsx', extension: 'xlsx', size: 42, mtimeMs: 10,
      tenantId: 'tenant-a', userId: 'user-a', locale: 'zh-CN', env,
    });
    expect(session).toMatchObject({
      mode: 'native', engine: 'onlyoffice', editable: false,
      scriptUrl: 'http://localhost:8082/web-apps/apps/api/documents/api.js',
      config: {
        documentType: 'cell',
        document: { fileType: 'xlsx', permissions: { edit: false, download: true } },
        editorConfig: { mode: 'view', lang: 'zh-CN' },
      },
    });
    expect(typeof session?.config.token).toBe('string');
    // Spreadsheets fill naturally — no fit-to-width override.
    expect((session?.config.editorConfig as { customization?: { zoom?: number } })?.customization?.zoom).toBeUndefined();
  });

  it('opens Word documents fit-to-width so they fill the panel instead of floating narrow', () => {
    const word = createNativeOfficeSession({
      path: '/data/guide.docx', filename: 'guide.docx', extension: 'docx', size: 42, mtimeMs: 10,
      tenantId: 'tenant-a', userId: 'user-a', locale: 'zh-CN', env,
    });
    expect(word?.config.documentType).toBe('word');
    // -2 = ONLYOFFICE "fit to width".
    expect((word?.config.editorConfig as { customization?: { zoom?: number } })?.customization?.zoom).toBe(-2);

    // Slides don't get the override (they already center/fit).
    const slide = createNativeOfficeSession({
      path: '/data/deck.pptx', filename: 'deck.pptx', extension: 'pptx', size: 42, mtimeMs: 10,
      tenantId: 'tenant-a', userId: 'user-a', locale: 'zh-CN', env,
    });
    expect((slide?.config.editorConfig as { customization?: { zoom?: number } })?.customization?.zoom).toBeUndefined();
  });

  it('stays disabled until every server-side setting and the shared secret exist', () => {
    expect(resolveNativeOfficeEnvironment({})).toBeNull();
    expect(resolveNativeOfficeEnvironment({
      OFFICE_DOCUMENT_SERVER_URL: 'http://localhost:8082',
      OFFICE_STORAGE_BASE_URL: 'http://mozi:9210',
      ONLYOFFICE_JWT_SECRET: 'secret',
    })).toMatchObject({ internalUrl: 'http://localhost:8082' });
  });
});
