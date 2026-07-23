/**
 * Interactive CLI onboarding wizard — @clack/prompts powered.
 *
 * UI layer only. All business logic reuses functions from ./index.ts.
 */

import * as p from '@clack/prompts';
import { isCancel } from '@clack/prompts';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { ensureMoziHome, getEnvPath, getConfigPath, getLegacyConfigPath, getReadableConfigPath } from '../paths.js';
import {
  detectProviders,
  checkProviderHealth,
  benchmarkModel,
  describeWorkspacePromptLayers,
  generateRouting,
  saveRoutingToConfig,
  scaffoldWorkspace,
  completeOnboarding,
  type ProviderInfo,
} from './index.js';
import { getWizardProviders } from '../core/providers.js';
import { execSync } from 'node:child_process';
import { readConfigWithLegacyFallback, writeConfigObject } from '../config/storage.js';
import { runChannelSelection, runChannelUpdate, buildChannelUpdateMenuItems, ensureChannelsInstalled } from './channels.js';
import { initDb } from '../store/db.js';
import { runMigrations } from '../store/migrate.js';
import { setBootstrapState, isOnboardingCompleted, resetOnboardingState } from './state.js';
import { startMoziInBackground } from '../runtime/daemon.js';
import { installService, detectServicePlatform } from '../runtime/service-install.js';
import {
  persistSearchKey,
  persistEnvValue,
  saveWizardRuntimeConfig,
  saveWorkspaceDirToConfig,
  validateOnboardingWriteContract,
} from './persistence.js';

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

export type SetupMode = 'fresh' | 'update';
export type ProviderRecoveryAction = 'retry' | 'reconfigure' | 'continue' | 'abort';

interface ProviderRecoveryHooks {
  askAction: (mode: SetupMode) => Promise<ProviderRecoveryAction>;
  verifyProviders: (providers: ProviderInfo[]) => Promise<ProviderInfo[]>;
  promptForProvider: () => Promise<ProviderInfo[]>;
  onCancel: (message: string, exitCode: number) => never;
  onWarn: (message: string) => void;
}

interface RunWizardOptions {
  acceptRisk?: boolean;
  autoStart?: boolean;
  autoBoot?: boolean;
  update?: boolean;
}

interface BrainSelection {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
}

interface BrainSelectionOption {
  value: string;
  label: string;
  hint: string;
  selection: BrainSelection;
}

export async function runWizard(options?: RunWizardOptions): Promise<void> {
  p.intro('MOZI — Onboarding');
  let setupMode: SetupMode = 'fresh';

  // Ensure ~/.mozi/ exists before anything else
  ensureMoziHome();

  // Init DB early (required for bootstrap state)
  initDb();
  runMigrations();

  // Check for existing onboarding state
  const configExists = existsSync(getReadableConfigPath());
  const alreadyCompleted = isOnboardingCompleted();

  if (options?.update && !(configExists || alreadyCompleted)) {
    p.log.warn('No existing configuration found. Running fresh onboarding instead.');
  }

  if (configExists || alreadyCompleted) {
    // When --update flag is set, skip straight to the update menu (no fresh-onboarding option)
    ensureChannelsInstalled();
    const channelMenuItems = buildChannelUpdateMenuItems();
    const action = await p.select({
      message: options?.update
        ? 'What would you like to update?'
        : 'MOZI is already configured. What would you like to do?',
      options: [
        { value: 'update_brain', label: 'Change brain model', hint: 'Switch to a different LLM model' },
        { value: 'update_provider', label: 'Add/change provider', hint: 'Reconfigure API keys' },
        { value: 'update_workspace', label: 'Change workspace directory', hint: 'Set a new workspace path' },
        ...channelMenuItems,
        { value: 'update_search', label: 'Change Search API key', hint: 'Update SEARCH1API_KEY' },
        { value: 'update_coding_worker', label: 'Configure coding workers', hint: 'Detect/change Claude Code or Codex CLI' },
        ...(!options?.update ? [
          { value: 'update_all' as const, label: 'Re-run full onboarding', hint: 'Restart the onboarding wizard from the beginning' },
          { value: 'overwrite' as const, label: 'Overwrite', hint: 'Start fresh, reset everything' },
        ] : []),
        { value: 'quit', label: 'Quit', hint: 'Cancel, keep current config' },
      ],
    });
    if (isCancel(action) || action === 'quit') {
      p.cancel('Keeping existing configuration.');
      process.exit(0);
    }
    if (action === 'update_brain') {
      await runBrainUpdate();
      p.outro('Done.');
      return;
    }
    if (action === 'update_provider') {
      await runProviderUpdate();
      p.outro('Done.');
      return;
    }
    if (action === 'update_workspace') {
      await runWorkspaceUpdate();
      p.outro('Done.');
      return;
    }
    if (typeof action === 'string' && action.startsWith('channel:')) {
      const channelId = action.slice('channel:'.length);
      await runChannelUpdate(channelId);
      p.outro('Done.');
      return;
    }
    if (action === 'update_search') {
      await runSearchUpdate();
      p.outro('Done.');
      return;
    }
    if (action === 'update_coding_worker') {
      await runCodingWorkerSetup();
      p.outro('Done.');
      return;
    }
    if (action === 'overwrite') {
      resetOnboardingState();
      for (const cfgPath of [getConfigPath(), getLegacyConfigPath()]) {
        if (existsSync(cfgPath)) {
          unlinkSync(cfgPath);
        }
      }
      p.log.info('Previous configuration cleared.');
    }
    if (action === 'update_all') {
      setupMode = 'update';
    }
    // 'update_all' → just continue the wizard, existing .env keys will be auto-detected
  }

  // 1. Risk acknowledgement
  if (!options?.acceptRisk) {
    p.note([
      'MOZI is an autonomous agent operating system.',
      'Once running, it MAY autonomously:',
      '',
      '  - Execute arbitrary shell commands on your machine',
      '  - Read, create, modify, and delete files',
      '  - Install or remove software packages',
      '  - Access network resources and external APIs',
      '  - Consume LLM API tokens (which cost real money)',
      '  - Spawn sub-agents that perform the above actions',
      '',
      'You are solely responsible for any consequences resulting',
      'from running MOZI, including but not limited to data loss,',
      'security breaches, unintended charges, or system damage.',
      '',
      'Recommended safety measures:',
      '  - Run in a sandboxed / containerized environment',
      '  - Limit filesystem access to the workspace directory',
      '  - Set API spending limits with your LLM provider',
      '  - Review agent actions regularly',
    ].join('\n'), 'Security & Liability Notice');

    const accepted = await p.confirm({
      message: 'I have read and accept the above risks.',
      active: 'Yes, I accept',
      inactive: 'No, cancel',
    });
    if (isCancel(accepted) || !accepted) {
      p.cancel('Onboarding cancelled. You must accept the risks to use MOZI.');
      process.exit(0);
    }
  }
  setBootstrapState('risk_accepted', 'true');

  // 2. Auto-detect existing env vars
  loadEnvFile();
  let providers = detectProviders();

  if (providers.length > 0) {
    p.note(providers.map(pr => pr.name).join(', '), 'Providers Detected');
  } else {
    // 3. Provider selection + API key
    providers = await promptForProvider();
  }

  // 4. Health check
  if (providers.length > 0) {
    const detectedProviders = providers;
    providers = await verifyProvidersWithReport(detectedProviders);

    if (providers.length === 0) {
      providers = await recoverFromFailedProviderVerification(setupMode, detectedProviders, {
        askAction: askProviderRecoveryAction,
        verifyProviders: verifyProvidersWithReport,
        promptForProvider,
        onCancel: (message, exitCode) => {
          p.cancel(message);
          process.exit(exitCode);
        },
        onWarn: (message) => {
          p.log.warn(message);
        },
      });
    }
  }

  // 5. Add additional providers (optional — for cost optimization)
  if (providers.length > 0) {
    const addMore = await p.confirm({
      message: 'Add another LLM provider? (e.g. a cheaper provider for simple tasks)',
      active: 'Yes',
      inactive: 'Skip',
      initialValue: false,
    });

    if (!isCancel(addMore) && addMore) {
      let keepAdding = true;
      while (keepAdding) {
        const extraProviders = await promptForProvider();
        if (extraProviders.length > 0) {
          const verified = await verifyProvidersWithReport(extraProviders);
          if (verified.length > 0) {
            providers.push(...verified);
            p.log.success(`Added ${verified.map(pr => pr.name).join(', ')}`);
          } else {
            p.log.warn('Provider failed health check — skipped.');
          }
        }

        const another = await p.confirm({
          message: 'Add yet another provider?',
          active: 'Yes',
          inactive: 'Done',
          initialValue: false,
        });
        keepAdding = !isCancel(another) && Boolean(another);
      }
    }
  }

  // 6. Search API key (optional but recommended for web_search/web_fetch)
  const searchKeyInput = await p.text({
    message: 'Search1API key for web_search/web_fetch (Enter to skip):',
    placeholder: 'SEARCH1API_KEY',
    defaultValue: '',
  });
  if (isCancel(searchKeyInput)) { p.cancel('Onboarding cancelled.'); process.exit(0); }

  const existingSearchKey = process.env.SEARCH1API_KEY?.trim();
  const trimmedSearchKey = searchKeyInput.trim();
  const requiredEnvKeys: string[] = [];
  if (trimmedSearchKey.length > 0) {
    persistSearchKey(trimmedSearchKey);
    requiredEnvKeys.push('SEARCH1API_KEY');
    p.log.success('Search tool key saved (SEARCH1API_KEY).');
  } else if (existingSearchKey) {
    p.log.info('Keeping existing SEARCH1API_KEY from environment.');
  } else {
    p.log.warn('SEARCH1API_KEY not set. web_search/web_fetch will stay disabled.');
  }

  // 7. Messaging channels — registry-driven. Any channel plugin that exposes
  // a `runWizard` appears here (Telegram, WeChat, Discord, Slack, ...).
  const channelSelection = await runChannelSelection();
  for (const key of channelSelection.persistedEnvKeys) {
    requiredEnvKeys.push(key);
  }

  // 8. Workspace directory
  const workspace = await p.text({
    message: 'Directory for agent workspace:',
    defaultValue: '~/.mozi/workspace',
    placeholder: '~/.mozi/workspace',
  });
  if (isCancel(workspace)) { p.cancel('Onboarding cancelled.'); process.exit(0); }
  const workDir = workspace || '~/.mozi/workspace';
  scaffoldWorkspace(workDir);
  p.note(describeWorkspacePromptLayers(workDir).join('\n'), 'Prompt Layers');

  // 9. Brain selection + benchmarking for routing
  if (providers.length > 0) {
    const brain = await promptForBrainSelection(providers);
    if (!brain) {
      p.cancel('Onboarding cancelled.');
      process.exit(0);
    }

    p.log.info(`Brain: ${brain.modelName} (${brain.providerName})`);

    const candidateModels = providers.flatMap(provider =>
      provider.models
        .filter(model => !(provider.id === brain.providerId && model.id === brain.modelId))
        .map(model => ({ provider, model })),
    );
    let results: Awaited<ReturnType<typeof benchmarkModel>>[] = [];

    if (candidateModels.length > 0) {
      const s = p.spinner();
      s.start('Benchmarking candidate models...');

      for (const candidate of candidateModels) {
        try {
          const result = await benchmarkModel(candidate.provider, candidate.model);
          results.push(result);
          s.message(`${candidate.model.name} — ${result.overall}% (${result.avgLatencyMs}ms)`);
        } catch { /* skip failed models */ }
      }

      if (results.length > 0) {
        s.stop('Benchmarks complete');
        p.note(
          results.map(r =>
            `${r.overall === 100 ? '✓' : '△'} ${r.modelId.padEnd(20)} — ${r.overall}% (${r.avgLatencyMs}ms)`
          ).join('\n'),
          'Candidate Model Results',
        );
      } else {
        s.stop('No candidate benchmarks completed');
      }
    }

    const routing = generateRouting(results, {
      provider: brain.providerId,
      model: brain.modelId,
    });
    saveRoutingToConfig(routing);
    p.log.success('Model routing configured.');
  }

  // 10. Coding Worker detection
  await runCodingWorkerSetup();

  // 11. Build Web UI (optional)
  if (existsSync('ui/package.json')) {
    const buildUi = await p.confirm({
      message: 'Build Web UI? (React dashboard at http://localhost:9210)',
      active: 'Yes',
      inactive: 'No',
      initialValue: true,
    });
    if (!isCancel(buildUi) && buildUi) {
      const s = p.spinner();
      s.start('Building Web UI...');
      const { execSync } = await import('node:child_process');
      try {
        execSync('pnpm install && pnpm build', { cwd: 'ui', stdio: 'pipe' });
        s.stop('Web UI built successfully');
      } catch {
        s.stop('Web UI build failed — you can run "pnpm ui:build" later');
      }
    }
  }

  // 12. Save config (workspace, server, telegram)
  saveWizardRuntimeConfig(workDir);
  const contractCheck = validateOnboardingWriteContract({
    workspaceDir: workDir,
    requiredEnvKeys,
  });
  if (!contractCheck.ok) {
    p.cancel(`Onboarding aborted: onboarding write contract failed.\n${contractCheck.errors.map(err => `- ${err}`).join('\n')}`);
    process.exit(1);
  }
  completeOnboarding();

  // Auto-boot: install a user service that starts MOZI on login + survives reboot.
  // Skipped on unsupported platforms (Windows) — falls through to the simple "start now" path.
  const servicePlatform = detectServicePlatform();
  const autoBootSupported = servicePlatform !== 'unsupported';
  const shouldAutoBoot = autoBootSupported
    ? (options?.autoBoot ?? await promptAutoBoot(servicePlatform))
    : false;

  if (shouldAutoBoot) {
    const s = p.spinner();
    s.start('Installing auto-start service...');
    const result = await installService();
    if (result.ok) {
      s.stop(`Service installed at ${result.unitPath}`);
      if (result.platform === 'linux' && result.linger === false) {
        p.log.info('Tip: to run MOZI even when logged out, run:  sudo loginctl enable-linger $USER');
      }
      p.outro(`Onboarding complete! MOZI will auto-start on every login. Logs: ${result.logPath}`);
      return;
    }
    s.stop(`Auto-start setup failed: ${result.error}`);
    p.log.warn('Falling back to foreground start prompt.');
  }

  const shouldAutoStart = options?.autoStart ?? await promptAutoStart();
  if (shouldAutoStart) {
    const launched = startMoziInBackground();
    if (launched.ok) {
      p.outro(`Onboarding complete! MOZI started in background (PID: ${launched.pid}). Logs: ${launched.logPath}`);
      return;
    }
    p.log.warn(`Onboarding complete, but auto-start failed: ${launched.error}`);
  }

  p.outro('Onboarding complete! Run: pnpm mozi start');
}

async function promptAutoBoot(plat: 'linux' | 'darwin'): Promise<boolean> {
  const label = plat === 'linux' ? 'systemd user unit' : 'launchd user agent';
  const enable = await p.confirm({
    message: `Enable auto-start on every boot? (installs ${label})`,
    active: 'Yes',
    inactive: 'No',
    initialValue: true,
  });

  return !isCancel(enable) && Boolean(enable);
}

async function promptAutoStart(): Promise<boolean> {
  const startNow = await p.confirm({
    message: 'Start MOZI now in background?',
    active: 'Yes',
    inactive: 'No',
    initialValue: true,
  });

  return !isCancel(startNow) && Boolean(startNow);
}

export function buildBrainSelectionOptions(
  providers: ProviderInfo[],
  current?: { providerId?: string; modelId?: string },
): BrainSelectionOption[] {
  let optionIndex = 0;
  return providers.flatMap((provider) => {
    const providerDef = getWizardProviders().find(def => def.id === provider.id);
    return provider.models.map((model) => {
      const hints = [provider.name];
      if (providerDef?.defaultModel === model.id) {
        hints.push('recommended');
      }
      if (current?.providerId === provider.id && current?.modelId === model.id) {
        hints.push('current');
      }
      const option: BrainSelectionOption = {
        value: String(optionIndex),
        label: model.name || model.id,
        hint: hints.join(', '),
        selection: {
          providerId: provider.id,
          providerName: provider.name,
          modelId: model.id,
          modelName: model.name || model.id,
        },
      };
      optionIndex += 1;
      return option;
    });
  });
}

async function promptForBrainSelection(
  providers: ProviderInfo[],
  current?: { providerId?: string; modelId?: string },
): Promise<BrainSelection | null> {
  const options = buildBrainSelectionOptions(providers, current);
  if (options.length === 0) {
    throw new Error('No models available for brain selection.');
  }

  // Add "custom model ID" option at the end
  const customOptionValue = '__custom_model__';
  const selectOptions = [
    ...options.map(option => ({
      value: option.value,
      label: option.label,
      hint: option.hint,
    })),
    {
      value: customOptionValue,
      label: 'Enter a custom model ID',
      hint: 'For newly released models not in the list above',
    },
  ];

  if (options.length === 1) {
    // Still show selection so user can pick custom
  }

  const choice = await p.select({
    message: 'Select the brain model for MOZI:',
    options: selectOptions,
  });
  if (isCancel(choice)) {
    return null;
  }

  if (choice === customOptionValue) {
    // Let user pick which provider to use
    const providerChoice = await p.select({
      message: 'Which provider should this model use?',
      options: providers.map(pr => ({ value: pr.id, label: pr.name })),
    });
    if (isCancel(providerChoice)) return null;

    const selectedProvider = providers.find(pr => pr.id === providerChoice)!;

    const modelId = await p.text({
      message: 'Enter the model ID:',
      placeholder: 'e.g. gpt-4.5, claude-opus-4-20250514',
      validate: v => (!v?.trim() ? 'Model ID is required' : undefined),
    });
    if (isCancel(modelId)) return null;

    return {
      providerId: selectedProvider.id,
      providerName: selectedProvider.name,
      modelId: modelId.trim(),
      modelName: modelId.trim(),
    };
  }

  return options.find(option => option.value === choice)?.selection ?? options[0].selection;
}

async function verifyProvidersWithReport(providers: ProviderInfo[]): Promise<ProviderInfo[]> {
  const s = p.spinner();
  s.start('Verifying providers...');

  for (const pr of providers) {
    pr.healthy = await checkProviderHealth(pr);
  }

  const healthy = providers.filter(pr => pr.healthy);
  s.stop('Verification complete');

  // Show detailed status for CLI providers (installed but not authorized)
  const lines = providers.map(pr => {
    if (pr.healthy) return `✓ ${pr.name}`;
    // Check if it's a CLI provider that's installed but not authorized
    const providerDef = getWizardProviders().find(d => d.id === pr.id);
    if (providerDef?.apiMode === 'cli-pipe') {
      try {
        execSync(`command -v ${providerDef.cliBackend?.command}`, { stdio: 'pipe' });
        return `△ ${pr.name} — installed but not authorized`;
      } catch { /* not installed */ }
    }
    return `✗ ${pr.name}`;
  });
  p.note(lines.join('\n'), 'Health Check');
  return healthy;
}

function getProviderRecoveryOptions(mode: SetupMode): Array<{ value: ProviderRecoveryAction; label: string; hint: string }> {
  const options: Array<{ value: ProviderRecoveryAction; label: string; hint: string }> = [
    {
      value: 'reconfigure',
      label: 'Reconfigure provider key',
      hint: 'Pick a provider and enter a new API key',
    },
    {
      value: 'retry',
      label: 'Retry verification',
      hint: 'Run health checks again with current keys',
    },
  ];

  if (mode === 'update') {
    options.push({
      value: 'continue',
      label: 'Continue update without verification',
      hint: 'Keep existing routing and finish onboarding',
    });
  }

  options.push({
    value: 'abort',
    label: mode === 'update' ? 'Abort update' : 'Abort onboarding',
    hint: 'Exit now',
  });

  return options;
}

async function askProviderRecoveryAction(mode: SetupMode): Promise<ProviderRecoveryAction> {
  const action = await p.select({
    message: mode === 'update'
      ? 'No provider passed verification during update. Next step?'
      : 'No provider passed verification. Next step?',
    options: getProviderRecoveryOptions(mode),
  });

  if (isCancel(action)) {
    return 'abort';
  }

  return action as ProviderRecoveryAction;
}

export async function recoverFromFailedProviderVerification(
  mode: SetupMode,
  initialProviders: ProviderInfo[],
  hooks: ProviderRecoveryHooks,
): Promise<ProviderInfo[]> {
  let candidates = initialProviders;

  while (true) {
    const action = await hooks.askAction(mode);

    if (action === 'abort') {
      return hooks.onCancel(
        mode === 'update'
          ? 'Update cancelled. Existing configuration kept.'
          : 'Onboarding cancelled. Configure a valid provider and try again.',
        mode === 'update' ? 0 : 1,
      );
    }

    if (action === 'continue') {
      if (mode === 'update') {
        hooks.onWarn('Continuing update without a verified provider. Existing routing is kept unchanged.');
        return [];
      }
      hooks.onWarn('Continue without verification is only available in update mode.');
      continue;
    }

    if (action === 'reconfigure' || candidates.length === 0) {
      candidates = await hooks.promptForProvider();
    }

    const healthy = await hooks.verifyProviders(candidates);
    if (healthy.length > 0) {
      return healthy;
    }

    hooks.onWarn('All configured providers failed health checks.');
  }
}

// ---------------------------------------------------------------------------
// Provider selection prompt
// ---------------------------------------------------------------------------

/** Check if a CLI command exists in PATH. */
function isCliAvailable(command: string): boolean {
  try {
    execSync(`command -v ${command}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function promptForProvider(): Promise<ProviderInfo[]> {
  const wizardProviders = getWizardProviders();
  const apiProviders = wizardProviders.filter(pr => pr.apiMode !== 'cli-pipe');
  const cliProviders = wizardProviders.filter(pr => pr.apiMode === 'cli-pipe');

  const selectOptions: Array<{ value: string; label: string; hint?: string }> = [
    ...apiProviders.map(pr => ({
      value: pr.id,
      label: pr.name,
      hint: pr.hint || pr.models.map(m => m.name).join(', '),
    })),
  ];

  // Add CLI providers with availability indicators
  if (cliProviders.length > 0) {
    for (const pr of cliProviders) {
      const available = pr.cliBackend ? isCliAvailable(pr.cliBackend.command) : false;
      selectOptions.push({
        value: pr.id,
        label: pr.name,
        hint: available
          ? `${pr.hint || ''} [installed]`.trim()
          : `${pr.hint || ''} [not found]`.trim(),
      });
    }
  }

  selectOptions.push({ value: 'custom', label: 'Custom (OpenAI-compatible)', hint: 'Any OpenAI-compatible API' });

  const providerId = await p.select({
    message: 'Select an LLM provider to configure:',
    options: selectOptions,
  });
  if (isCancel(providerId)) { p.cancel('Onboarding cancelled.'); process.exit(0); }

  // Custom provider — user provides base URL + API key + model
  if (providerId === 'custom') {
    const baseUrl = await p.text({
      message: 'API base URL (OpenAI-compatible):',
      placeholder: 'https://api.example.com/v1',
      validate: v => (!v ? 'URL is required' : undefined),
    });
    if (isCancel(baseUrl)) { p.cancel('Onboarding cancelled.'); process.exit(0); }

    const apiKey = await p.text({
      message: 'Enter your API key:',
      placeholder: 'sk-...',
      validate: v => (!v ? 'API key is required' : undefined),
    });
    if (isCancel(apiKey)) { p.cancel('Onboarding cancelled.'); process.exit(0); }

    const modelId = await p.text({
      message: 'Enter a model ID to use:',
      placeholder: 'gpt-4.1-mini',
      validate: v => (!v ? 'Model ID is required' : undefined),
    });
    if (isCancel(modelId)) { p.cancel('Onboarding cancelled.'); process.exit(0); }

    persistEnvValue('CUSTOM_API_KEY', apiKey);

    return [{
      id: 'custom',
      name: 'Custom',
      apiKey,
      baseUrl,
      models: [{ id: modelId, name: modelId, provider: 'custom' }],
      healthy: false,
    }];
  }

  // Known provider — use registry metadata
  const choice = wizardProviders.find(pr => pr.id === providerId)!;

  // CLI-pipe provider — verify CLI exists, no API key needed
  if (choice.apiMode === 'cli-pipe' && choice.cliBackend) {
    const command = choice.cliBackend.command;
    if (!isCliAvailable(command)) {
      p.log.error(`"${command}" not found in PATH. Install it first, then re-run onboarding.`);
      // Let user pick another provider
      return promptForProvider();
    }
    p.log.success(`Found "${command}" CLI in PATH — no API key needed.`);

    return [{
      id: choice.id,
      name: choice.name,
      apiKey: '',
      models: choice.models.map(m => ({ id: m.id, name: m.name, provider: choice.id })),
      healthy: false,
    }];
  }

  let selectedBaseUrl = choice.baseUrl;

  // Region selection (e.g. MiniMax global vs China vs proxy)
  if (choice.regions && choice.regions.length > 0) {
    const regionId = await p.select({
      message: `Select ${choice.name} region:`,
      options: choice.regions.map(r => ({
        value: r.id,
        label: r.name,
      })),
    });
    if (isCancel(regionId)) { p.cancel('Onboarding cancelled.'); process.exit(0); }

    const selectedRegion = choice.regions.find(r => r.id === regionId)!;

    if (selectedRegion.baseUrl) {
      // Official endpoint — use Anthropic adapter
      selectedBaseUrl = selectedRegion.baseUrl;
    } else {
      // Proxy/custom — user provides their own base URL (OpenAI-compatible)
      const customUrl = await p.text({
        message: `Enter your ${choice.name} proxy base URL:`,
        placeholder: 'https://api.example.com/v1',
        validate: v => (!v ? 'URL is required' : undefined),
      });
      if (isCancel(customUrl)) { p.cancel('Onboarding cancelled.'); process.exit(0); }
      selectedBaseUrl = customUrl;
    }

    // Persist the base URL override so it's used on future starts
    const baseUrlEnvKey = `${choice.id.toUpperCase()}_BASE_URL`;
    persistEnvValue(baseUrlEnvKey, selectedBaseUrl);
  }

  const apiKey = await p.text({
    message: `Enter your ${choice.name} API key:`,
    placeholder: choice.placeholder || 'sk-...',
    validate: v => (!v ? 'API key is required' : undefined),
  });
  if (isCancel(apiKey)) { p.cancel('Onboarding cancelled.'); process.exit(0); }

  // Save to the provider's own env var (not OPENAI_API_KEY!)
  persistEnvValue(choice.envKey, apiKey);

  return [{
    id: choice.id,
    name: choice.name,
    apiKey,
    baseUrl: selectedBaseUrl,
    models: choice.models.map(m => ({ id: m.id, name: m.name, provider: choice.id })),
    healthy: false,
  }];
}

// ---------------------------------------------------------------------------
// Targeted update flows
// ---------------------------------------------------------------------------

/**
 * Quick brain model change — detect providers, show all models, let user pick.
 * Skips risk ack, benchmarks, search key, telegram, workspace, etc.
 */
async function runBrainUpdate(): Promise<void> {
  loadEnvFile();
  let providers = detectProviders();

  if (providers.length === 0) {
    p.log.error('No LLM providers detected. Run full onboarding to configure a provider.');
    return;
  }

  // Health check
  const s = p.spinner();
  s.start('Checking providers...');
  for (const pr of providers) {
    pr.healthy = await checkProviderHealth(pr);
  }
  providers = providers.filter(pr => pr.healthy);
  s.stop('Providers checked');

  if (providers.length === 0) {
    p.log.error('All providers failed health check. Check your API keys.');
    return;
  }

  // Read current brain from config
  const config = readConfigWithLegacyFallback(getConfigPath()).config;
  const currentBrainModel = (config.brain as Record<string, unknown>)?.model as string | undefined;
  const currentBrainProvider = (config.model_router as Record<string, unknown> | undefined)?.brain_provider as string | undefined;
  const selection = await promptForBrainSelection(providers, {
    providerId: currentBrainProvider,
    modelId: currentBrainModel,
  });
  if (!selection) {
    p.cancel('Cancelled.');
    return;
  }

  // Update brain + brain_provider in config
  const existing = readConfigWithLegacyFallback(getConfigPath()).config;
  if (!existing.brain) existing.brain = {};
  (existing.brain as Record<string, unknown>).model = selection.modelId;
  if (!existing.model_router) existing.model_router = {};
  (existing.model_router as Record<string, unknown>).brain_provider = selection.providerId;
  writeConfigObject(getConfigPath(), existing);

  p.log.success(`Brain updated: ${selection.modelName} (${selection.providerName})`);
}

/**
 * Add or change a provider — prompts for provider + API key, verifies health.
 * Skips risk ack, benchmarks, workspace, search key, telegram, etc.
 */
async function runProviderUpdate(): Promise<void> {
  loadEnvFile();

  const newProviders = await promptForProvider();
  if (newProviders.length === 0) return;

  const verified = await verifyProvidersWithReport(newProviders);
  if (verified.length > 0) {
    p.log.success(`Provider verified: ${verified.map(pr => pr.name).join(', ')}`);

    const switchBrain = await p.confirm({
      message: 'Use this provider as your brain?',
      active: 'Yes',
      inactive: 'No',
      initialValue: false,
    });

    if (!isCancel(switchBrain) && switchBrain) {
      const brainSelection = await promptForBrainSelection(verified);
      if (!brainSelection) {
        p.cancel('Cancelled.');
        return;
      }

      const existing = readConfigWithLegacyFallback(getConfigPath()).config;
      if (!existing.brain) existing.brain = {};
      (existing.brain as Record<string, unknown>).model = brainSelection.modelId;
      if (!existing.model_router) existing.model_router = {};
      (existing.model_router as Record<string, unknown>).brain_provider = brainSelection.providerId;
      writeConfigObject(getConfigPath(), existing);

      p.log.success(`Brain switched to: ${brainSelection.modelName} (${brainSelection.providerName})`);
    }
  } else {
    p.log.warn('Provider failed health check. API key was saved — you can retry later.');
  }
}

/**
 * Change workspace directory — prompt for new path, save to config.
 */
async function runWorkspaceUpdate(): Promise<void> {
  loadEnvFile();

  const config = readConfigWithLegacyFallback(getConfigPath()).config;
  const currentDir = ((config.workspace ?? {}) as Record<string, unknown>).dir as string | undefined;

  const workspace = await p.text({
    message: 'New workspace directory:',
    defaultValue: currentDir || '~/.mozi/workspace',
    placeholder: currentDir || '~/.mozi/workspace',
  });
  if (isCancel(workspace)) { p.cancel('Cancelled.'); return; }

  const workDir = workspace || '~/.mozi/workspace';
  scaffoldWorkspace(workDir);
  saveWorkspaceDirToConfig(workDir);

  p.log.success(`Workspace updated: ${workDir}`);
  p.note(describeWorkspacePromptLayers(workDir).join('\n'), 'Prompt Layers');
}

/**
 * Change Search API key — prompt for new key, save.
 */
async function runSearchUpdate(): Promise<void> {
  loadEnvFile();

  const currentKey = process.env.SEARCH1API_KEY;
  if (currentKey) {
    const masked = currentKey.slice(0, 4) + '...' + currentKey.slice(-4);
    p.log.info(`Current key: ${masked}`);
  }

  const searchKey = await p.text({
    message: 'New Search1API key for web_search/web_fetch:',
    placeholder: 'SEARCH1API_KEY',
    validate: v => (!v ? 'Key is required' : undefined),
  });
  if (isCancel(searchKey)) { p.cancel('Cancelled.'); return; }

  persistSearchKey(searchKey.trim());
  p.log.success('Search API key updated (SEARCH1API_KEY).');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coding Worker setup step — detect installed CLI tools and let user choose routing.
 * Non-blocking: if no CLI is found, the user can skip and install later.
 */
async function runCodingWorkerSetup(): Promise<void> {
  const {
    detectCodingWorkers,
    recommendRouting,
    buildCodingWorkerConfig,
  } = await import('./coding-workers.js');
  type CodingWorkerRouting = Awaited<ReturnType<typeof recommendRouting>>;

  const s = p.spinner();
  s.start('Detecting coding workers...');
  const probes = detectCodingWorkers();
  s.stop('Detection complete');

  const lines = probes.map(probe => {
    if (!probe.installed) {
      return `  \u2717 ${probe.name} \u2014 not installed`;
    }
    if (!probe.authorized) {
      return `  \u25B3 ${probe.name} (${probe.version ?? '?'}) \u2014 installed but not authorized`;
    }
    return `  \u2713 ${probe.name} (${probe.version ?? '?'}) \u2014 ready`;
  });
  p.note(lines.join('\n'), 'Coding Workers');

  const ready = probes.filter(probe => probe.installed && probe.authorized);
  const installedNotAuth = probes.filter(probe => probe.installed && !probe.authorized);
  const notInstalled = probes.filter(probe => !probe.installed);

  if (ready.length === 0) {
    // No CLI tools ready — give guidance but don't block
    const hints: string[] = [];
    if (installedNotAuth.length > 0) {
      hints.push('Installed but need authorization:');
      for (const probe of installedNotAuth) {
        hints.push(`  ${probe.name}: ${probe.authHint}`);
      }
    }
    if (notInstalled.length > 0) {
      hints.push('Not installed (pick any one):');
      for (const probe of notInstalled) {
        hints.push(`  ${probe.name}: ${probe.installHint}`);
      }
    }
    hints.push('');
    hints.push('You can install and authorize later \u2014 MOZI will detect them on next startup.');
    hints.push('Or ask MOZI to help you set them up after onboarding.');
    p.note(hints.join('\n'), 'No coding worker ready');

    // Save empty config — auto routing with nothing available
    const config = buildCodingWorkerConfig(probes, 'auto');
    saveCodingWorkerConfig(config);
    return;
  }

  // At least one worker is ready — let user choose routing
  const recommended = recommendRouting(probes);
  const selectOptions: Array<{ value: string; label: string; hint: string }> = [];

  if (ready.length >= 2) {
    selectOptions.push({
      value: 'auto',
      label: 'Auto-route',
      hint: 'Simple tasks \u2192 fast worker, complex tasks \u2192 deep worker',
    });
  }
  for (const probe of ready) {
    selectOptions.push({
      value: probe.id,
      label: probe.name,
      hint: `${probe.version ?? ''} \u2014 use for all coding tasks`.trim(),
    });
  }

  const choice = await p.select({
    message: 'Default coding worker:',
    options: selectOptions,
    initialValue: recommended,
  });

  const routing: CodingWorkerRouting = isCancel(choice) ? recommended : choice as CodingWorkerRouting;
  const config = buildCodingWorkerConfig(probes, routing);
  saveCodingWorkerConfig(config);

  const label = routing === 'auto'
    ? 'Auto-route'
    : ready.find(r => r.id === routing)?.name ?? routing;
  p.log.success(`Coding worker: ${label}`);
}

function saveCodingWorkerConfig(config: { routing: string; available: string[] }): void {
  const existing = readConfigWithLegacyFallback(getConfigPath()).config;
  (existing as Record<string, unknown>).coding_worker = config;
  writeConfigObject(getConfigPath(), existing);
}

/** Load .env file into process.env (only sets unset vars). */
function loadEnvFile(): void {
  const envPath = getEnvPath();
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx);
      const value = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = value;
    }
  }
}
