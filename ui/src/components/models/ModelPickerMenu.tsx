import { useMemo, type ReactNode } from "react";
import { Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLocale } from "@/i18n";
import {
  formatContext,
  providerSelectable,
  type CatalogModel,
  type CatalogProvider,
} from "@/lib/model-catalog";
import { cn } from "@/lib/utils";
import { ProviderBadge } from "@/components/models/ProviderBadge";

interface ModelPickerMenuProps {
  providers: CatalogProvider[];
  selectedProvider?: string;
  selectedModel?: string;
  trigger: ReactNode;
  onSelect: (provider: CatalogProvider, model: CatalogModel) => void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  disabled?: boolean;
  contentClassName?: string;
}

export function ModelPickerMenu({
  providers,
  selectedProvider = "",
  selectedModel = "",
  trigger,
  onSelect,
  side = "top",
  align = "end",
  disabled = false,
  contentClassName,
}: ModelPickerMenuProps) {
  const { t } = useLocale();
  const visibleProviders = useMemo(() => providers
    .map((provider) => ({
      ...provider,
      models: provider.models.filter((model) => model.allowed !== false),
    }))
    .filter((provider) => provider.models.length > 0), [providers]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-testid="model-picker-menu"
        side={side}
        align={align}
        sideOffset={8}
        className={cn(
          "max-h-[340px] w-[300px] overflow-y-auto rounded-lg border border-ink/[0.10] bg-elevated p-1 text-ink shadow-[0_24px_70px_-28px_rgba(0,0,0,0.72)]",
          contentClassName,
        )}
      >
        {(() => {
          // Only providers with a configured key are offered — an unusable,
          // greyed-out catalog is noise, not choice. Key management lives in
          // Settings → API Keys.
          const usable = visibleProviders.filter((provider) => providerSelectable(provider));
          if (usable.length === 0) {
            return (
              <div className="px-3 py-4 text-center text-[12px] text-ink/40">{t("settings.provider.noResults")}</div>
            );
          }
          return usable.map((provider, index) => {
            return (
              <div key={provider.id}>
                {index > 0 && <DropdownMenuSeparator className="mx-2 my-1 bg-ink/[0.06]" />}
                {provider.models.map((model) => {
                  const active = selectedProvider === provider.id && selectedModel === model.id;
                  return (
                    <DropdownMenuItem
                      key={`${provider.id}:${model.id}`}
                      data-model-option={`${provider.id}:${model.id}`}
                      onSelect={() => onSelect(provider, model)}
                      className="mx-1 flex h-10 cursor-pointer items-center gap-2.5 rounded-md px-2 text-left text-ink/80 focus:bg-ink/[0.06] focus:text-ink data-[disabled]:cursor-not-allowed data-[disabled]:opacity-35"
                    >
                      <ProviderBadge id={provider.id} name={provider.name} size="xs" />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={model.id}>
                        {model.id}
                      </span>
                      {typeof model.contextWindow === "number" && model.contextWindow > 0 && (
                        <span className="shrink-0 text-[11px] tabular-nums text-ink/38">{formatContext(model.contextWindow)}</span>
                      )}
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {active && <Check className="h-3.5 w-3.5 text-selection" />}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </div>
            );
          });
        })()}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CapabilityChips({ model, compact = false }: { model?: CatalogModel; compact?: boolean }) {
  const { t } = useLocale();
  if (!model) return null;
  const chips: string[] = [];
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    chips.push(t("model.capability.context", { value: formatContext(model.contextWindow) }));
  }
  if (model.supportsTools) chips.push(t("model.capability.tools"));
  if (model.supportsVision) chips.push(t("model.capability.vision"));
  if (chips.length === 0) return null;
  if (compact) {
    return (
      <>
        {chips.map((chip, index) => (
          <span key={chip} className="whitespace-nowrap">
            {index > 0 ? "· " : ""}
            {chip}
          </span>
        ))}
      </>
    );
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <span key={chip} className="rounded border border-ink/[0.06] bg-ink/[0.035] px-1.5 py-0.5 text-[10.5px] text-ink/45">
          {chip}
        </span>
      ))}
    </span>
  );
}
