import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeImage } from './vision.js';
import { createTempDir, removeTempDir } from '../test-helpers.js';

let tmpDir: string;

// Mock the model-router and providers to control vision config in tests
vi.mock('../core/model-router.js', () => ({
  getSelectionForRole: vi.fn().mockReturnValue({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    role: 'vision',
  }),
}));

vi.mock('../core/providers.js', () => ({
  getProvider: vi.fn().mockReturnValue({
    id: 'openai',
    name: 'OpenAI',
    apiMode: 'openai-responses',
    env: { primaryKey: 'OPENAI_API_KEY' },
    baseUrl: 'https://api.openai.com/v1',
  }),
  resolveApiKey: vi.fn().mockImplementation((providerId: string) => {
    if (providerId === 'openai') return process.env.OPENAI_API_KEY || undefined;
    return undefined;
  }),
  resolveBaseUrl: vi.fn().mockReturnValue('https://api.openai.com/v1'),
  getVisionCapableProviders: vi.fn().mockReturnValue([]),
}));

const originalApiKey = process.env.OPENAI_API_KEY;

describe('capabilities/vision', () => {
  beforeEach(() => {
    tmpDir = createTempDir();
    process.env.OPENAI_API_KEY = 'test-openai-key';
  });

  afterEach(() => {
    removeTempDir(tmpDir);
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  });

  it('sends image_url content to configured vision model and returns analysis text', async () => {
    const imagePath = join(tmpDir, 'photo.jpg');
    writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff]));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'A small test image.',
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await analyzeImage(imagePath, 'custom prompt');
    expect(result).toBe('A small test image.');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-openai-key');

    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
    };
    expect(body.model).toBe('gpt-4.1-mini');
    expect(body.messages[0].content[0]?.type).toBe('text');
    expect(body.messages[0].content[0]?.text).toBe('custom prompt');
    expect(body.messages[0].content[1]?.type).toBe('image_url');
    expect(body.messages[0].content[1]?.image_url?.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('throws when API key is missing for the vision provider', async () => {
    const imagePath = join(tmpDir, 'photo.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    delete process.env.OPENAI_API_KEY;

    await expect(analyzeImage(imagePath)).rejects.toThrow('No vision-capable provider available');
  });

  it('sends max_tokens=2048 by default (issue #267 — was hardcoded 500 and truncating reports)', async () => {
    const imagePath = join(tmpDir, 'photo.jpg');
    writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff]));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await analyzeImage(imagePath);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { max_tokens: number };
    expect(body.max_tokens).toBe(2048);
  });

  it('honors MOZI_VISION_MAX_TOKENS env override', async () => {
    const imagePath = join(tmpDir, 'photo.jpg');
    writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff]));
    process.env.MOZI_VISION_MAX_TOKENS = '8192';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await analyzeImage(imagePath);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { max_tokens: number };
      expect(body.max_tokens).toBe(8192);
    } finally {
      delete process.env.MOZI_VISION_MAX_TOKENS;
    }
  });

  it('falls back to default when MOZI_VISION_MAX_TOKENS is invalid', async () => {
    const imagePath = join(tmpDir, 'photo.jpg');
    writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff]));
    process.env.MOZI_VISION_MAX_TOKENS = 'not-a-number';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await analyzeImage(imagePath);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { max_tokens: number };
      expect(body.max_tokens).toBe(2048);
    } finally {
      delete process.env.MOZI_VISION_MAX_TOKENS;
    }
  });

  it('throws API error details when vision API returns non-OK', async () => {
    const imagePath = join(tmpDir, 'photo.webp');
    writeFileSync(imagePath, Buffer.from([0x52, 0x49, 0x46, 0x46]));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    }));

    await expect(analyzeImage(imagePath)).rejects.toThrow('Vision API error 401: Unauthorized');
  });
});
