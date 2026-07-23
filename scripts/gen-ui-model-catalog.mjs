/**
 * Generate the Web UI's model-catalog seed from the single source of truth
 * (src/core/provider-catalog.ts). The UI ships this JSON so the model browser is
 * rich and visible even when the running backend predates GET /api/providers.
 *
 * Re-run after changing the provider catalog:
 *   node --experimental-strip-types scripts/gen-ui-model-catalog.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PROVIDERS, WIZARD_PROVIDER_IDS } from '../src/core/provider-catalog.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'ui', 'src', 'data', 'model-catalog.generated.json');

const providers = WIZARD_PROVIDER_IDS
  .map((id) => PROVIDERS[id])
  .filter(Boolean)
  .map((provider) => ({
    id: provider.id,
    name: provider.name,
    hint: provider.hint ?? null,
    defaultModel: provider.defaultModel,
    apiMode: provider.apiMode,
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.name,
      tier: model.tier,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      supportsTools: model.supportsTools,
      supportsVision: model.supportsVision,
      reasoning: model.reasoning,
      inputCostPer1M: model.inputCostPer1M ?? null,
      outputCostPer1M: model.outputCostPer1M ?? null,
    })),
  }));

const payload = {
  _comment: 'GENERATED from src/core/provider-catalog.ts — do not edit by hand. Regenerate with scripts/gen-ui-model-catalog.mjs',
  providers,
};

writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
console.log(`Wrote ${providers.length} providers, ${providers.reduce((n, p) => n + p.models.length, 0)} models -> ${outPath}`);
