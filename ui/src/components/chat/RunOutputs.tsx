import type { Artifact } from "@/types";
import { useLocale } from "@/i18n";
import ArtifactCard from "./ArtifactCard";

export default function RunOutputs({ artifacts, onOpen }: { artifacts: Artifact[]; onOpen: (artifact: Artifact) => void }) {
  const { t } = useLocale();
  return (
    <section className="space-y-3 p-5" data-testid="run-tab-outputs">
      {artifacts.length === 0 ? <p className="py-12 text-center text-[12.5px] text-ink/38">{t("run.outputs.empty")}</p> : artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} onOpen={onOpen} />)}
    </section>
  );
}
