import { describe, expect, it, vi } from 'vitest';
import type { ProviderInfo } from './index.js';
import { buildBrainSelectionOptions, recoverFromFailedProviderVerification } from './wizard.js';

function makeProvider(id = 'openai', name = 'OpenAI'): ProviderInfo {
  return {
    id,
    name,
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
    models: [{ id: 'test-model', name: 'Test Model', provider: id }],
    healthy: false,
  };
}

describe('onboarding wizard provider recovery', () => {
  it('allows update flow to continue without a verified provider', async () => {
    const initial = [makeProvider('openai')];
    const askAction = vi.fn(async () => 'continue' as const);
    const verifyProviders = vi.fn(async () => initial);
    const promptForProvider = vi.fn(async () => [makeProvider('anthropic', 'Anthropic')]);
    const onWarn = vi.fn();
    const onCancel = vi.fn((message: string): never => {
      throw new Error(`unexpected cancel: ${message}`);
    });

    const result = await recoverFromFailedProviderVerification('update', initial, {
      askAction,
      verifyProviders,
      promptForProvider,
      onWarn,
      onCancel,
    });

    expect(result).toEqual([]);
    expect(verifyProviders).not.toHaveBeenCalled();
    expect(promptForProvider).not.toHaveBeenCalled();
    expect(onWarn).toHaveBeenCalledWith(
      'Continuing update without a verified provider. Existing routing is kept unchanged.',
    );
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('reconfigures provider and returns healthy result', async () => {
    const initial = [makeProvider('openai')];
    const reconfigured = [makeProvider('minimax', 'MiniMax')];
    reconfigured[0].healthy = true;

    const askAction = vi.fn(async () => 'reconfigure' as const);
    const verifyProviders = vi.fn(async (providers: ProviderInfo[]) => providers);
    const promptForProvider = vi.fn(async () => reconfigured);
    const onWarn = vi.fn();
    const onCancel = vi.fn((message: string): never => {
      throw new Error(`unexpected cancel: ${message}`);
    });

    const result = await recoverFromFailedProviderVerification('fresh', initial, {
      askAction,
      verifyProviders,
      promptForProvider,
      onWarn,
      onCancel,
    });

    expect(promptForProvider).toHaveBeenCalledTimes(1);
    expect(verifyProviders).toHaveBeenCalledTimes(1);
    expect(verifyProviders).toHaveBeenCalledWith(reconfigured);
    expect(result).toEqual(reconfigured);
    expect(onWarn).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('aborts fresh setup with non-zero exit intent', async () => {
    const initial = [makeProvider('openai')];
    const askAction = vi.fn(async () => 'abort' as const);
    const verifyProviders = vi.fn(async () => []);
    const promptForProvider = vi.fn(async () => []);
    const onWarn = vi.fn();
    const onCancel = vi.fn((message: string, exitCode: number): never => {
      throw new Error(`cancel:${exitCode}:${message}`);
    });

    await expect(
      recoverFromFailedProviderVerification('fresh', initial, {
        askAction,
        verifyProviders,
        promptForProvider,
        onWarn,
        onCancel,
      }),
    ).rejects.toThrow('cancel:1:Onboarding cancelled. Configure a valid provider and try again.');

    expect(verifyProviders).not.toHaveBeenCalled();
    expect(promptForProvider).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('onboarding wizard brain selection options', () => {
  it('marks recommended and current models in brain selection hints', () => {
    const providers: ProviderInfo[] = [
      {
        id: 'openai',
        name: 'OpenAI',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        models: [
          { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai' },
          { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', provider: 'openai' },
        ],
        healthy: true,
      },
    ];

    const options = buildBrainSelectionOptions(providers, {
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
    });

    expect(options).toHaveLength(2);
    expect(options[0].hint).toContain('OpenAI');
    expect(options[0].hint).toContain('recommended');
    expect(options[1].hint).toContain('current');
    expect(options[1].selection.modelId).toBe('gpt-4.1-mini');
  });
});
