import { createHash } from 'node:crypto';
import { sign, verify } from '../security/jwt.js';

const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp']);

export interface NativeOfficeEnvironment {
  browserUrl: string;
  internalUrl: string;
  storageBaseUrl: string;
  jwtSecret: string;
}

export function resolveNativeOfficeEnvironment(env: NodeJS.ProcessEnv = process.env): NativeOfficeEnvironment | null {
  const browserUrl = env.OFFICE_DOCUMENT_SERVER_URL?.trim().replace(/\/+$/, '') ?? '';
  const internalUrl = (env.OFFICE_DOCUMENT_SERVER_INTERNAL_URL?.trim() || browserUrl).replace(/\/+$/, '');
  const storageBaseUrl = env.OFFICE_STORAGE_BASE_URL?.trim().replace(/\/+$/, '') ?? '';
  const jwtSecret = env.ONLYOFFICE_JWT_SECRET?.trim() ?? '';
  if (!browserUrl || !internalUrl || !storageBaseUrl || !jwtSecret) return null;
  return { browserUrl, internalUrl, storageBaseUrl, jwtSecret };
}

export function nativeOfficeDocumentType(extension: string): 'word' | 'cell' | 'slide' | null {
  const ext = extension.toLowerCase().replace(/^\./, '');
  if (!OFFICE_EXTENSIONS.has(ext)) return null;
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return 'cell';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return 'slide';
  return 'word';
}

export function createNativeOfficeSession(input: {
  path: string;
  filename: string;
  extension: string;
  size: number;
  mtimeMs: number;
  tenantId: string;
  userId: string;
  userName?: string;
  locale?: string;
  env: NativeOfficeEnvironment;
}) {
  const documentType = nativeOfficeDocumentType(input.extension);
  if (!documentType) return null;
  const versionKey = createHash('sha256')
    .update(`${input.path}\0${input.size}\0${input.mtimeMs}`)
    .digest('hex')
    .slice(0, 40);
  const fileToken = sign(input.userId, input.env.jwtSecret, 600, {
    purpose: 'office_file',
    path: input.path,
    tenant_id: input.tenantId,
    user_id: input.userId,
    version: versionKey,
  });
  const fileUrl = `${input.env.storageBaseUrl}/api/office/file?token=${encodeURIComponent(fileToken)}`;
  const config: Record<string, unknown> = {
    documentType,
    type: 'desktop',
    document: {
      fileType: input.extension.toLowerCase().replace(/^\./, ''),
      key: versionKey,
      title: input.filename,
      url: fileUrl,
      permissions: {
        edit: false,
        download: true,
        print: true,
        review: false,
        comment: false,
      },
    },
    editorConfig: {
      mode: 'view',
      lang: input.locale?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en',
      user: { id: input.userId, name: input.userName || input.userId },
      customization: {
        autosave: false,
        forcesave: false,
        plugins: false,
        // Word documents are a fixed-width page; in a wide preview panel they'd
        // otherwise float as a narrow column with large empty margins. -2 =
        // "fit to width" (ONLYOFFICE docs), so the page fills the panel instead
        // of leaving an ugly void. Slides already center/fit; sheets fill
        // naturally — only 'word' needs it.
        ...(documentType === 'word' ? { zoom: -2 } : {}),
      },
    },
  };
  config.token = sign(input.userId, input.env.jwtSecret, 3600, config);
  return {
    mode: 'native' as const,
    engine: 'onlyoffice' as const,
    editable: false,
    scriptUrl: `${input.env.browserUrl}/web-apps/apps/api/documents/api.js`,
    config,
  };
}

export function verifyNativeOfficeFileToken(token: string, secret: string): { path: string; tenantId: string; userId: string } | null {
  const payload = verify(token, secret);
  if (!payload || payload.purpose !== 'office_file') return null;
  if (typeof payload.path !== 'string' || typeof payload.tenant_id !== 'string' || typeof payload.user_id !== 'string') return null;
  return { path: payload.path, tenantId: payload.tenant_id, userId: payload.user_id };
}
