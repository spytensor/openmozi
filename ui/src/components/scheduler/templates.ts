/**
 * Starting points for the empty scheduled page.
 *
 * These are content, not decoration: the empty state used to say "nothing
 * scheduled" and teach nothing, so an operator had no idea what the feature was
 * for. Each template prefills the composer — it is a draft to edit, never
 * something that runs on one click.
 *
 * Two rules held while writing these:
 *
 * 1. **Only what MOZI can actually do.** Every prompt leans on capabilities
 *    that exist — the bundled skills (pptx, xlsx, docx, data-analysis,
 *    financial-analysis, research-workflow, internal-comms), git and shell,
 *    web fetch and search. Nothing here implies a capability the runtime would
 *    have to fake, and none of them name a skill explicitly: the Brain picks
 *    its own route, and hard-coding one would rot the moment a skill is renamed.
 * 2. **Something worth keeping on.** A template earns its place if a real
 *    operator would still have it running a month later. That rules out the
 *    novelty end of the category — a daily fun fact is a demo, not a tool.
 *
 * Each prompt says what to produce and where to put it, because an unattended
 * run has nobody to ask a clarifying question.
 */
import {
  Activity,
  BellRing,
  ChartLine,
  FileText,
  GitPullRequest,
  Presentation,
  Radar,
  ShieldCheck,
  Table2,
  Inbox,
  type LucideIcon,
} from "lucide-react";
import type { MessageKey } from "@/i18n";
import type { ScheduleDraft } from "./draft";
import { emptyDraft } from "./draft";

export interface ScheduleTemplate {
  id: string;
  icon: LucideIcon;
  titleKey: MessageKey;
  blurbKey: MessageKey;
  draft: () => ScheduleDraft;
}

export const SCHEDULE_TEMPLATES: ScheduleTemplate[] = [
  {
    id: "weekly-repo-report",
    icon: GitPullRequest,
    titleKey: "scheduled.tpl.repoReport.title",
    blurbKey: "scheduled.tpl.repoReport.blurb",
    draft: () => ({
      ...emptyDraft("prompt"),
      repeat: "weekly",
      weekday: 5,
      time: "17:00",
      body:
        "Summarise this week in the repository: merged pull requests, closed issues, and anything still open that looks stuck. "
        + "Group by theme rather than listing commits. Call out changes that affect how the project is run or released. "
        + "Write it as a short document in output/ and tell me the one thing most worth my attention.",
    }),
  },
  {
    id: "market-brief",
    icon: ChartLine,
    titleKey: "scheduled.tpl.marketBrief.title",
    blurbKey: "scheduled.tpl.marketBrief.blurb",
    draft: () => ({
      ...emptyDraft("prompt"),
      repeat: "weekdays",
      time: "08:30",
      body:
        "Brief me on yesterday's close for the markets and tickers I follow. "
        + "Lead with what actually moved and why — skip anything that just drifted. "
        + "If a move looks unusual against its recent range, say so and give the likely reason. "
        + "Keep it to what I can read in two minutes.",
    }),
  },
  {
    id: "watch-page",
    icon: Radar,
    titleKey: "scheduled.tpl.watchPage.title",
    blurbKey: "scheduled.tpl.watchPage.blurb",
    draft: () => ({
      ...emptyDraft("prompt"),
      repeat: "interval",
      intervalValue: "6",
      intervalUnit: "hours",
      body:
        "Check <paste the URL here> and compare it against what you found last time. "
        + "If nothing meaningful changed, say exactly that in one line and stop. "
        + "If something did, tell me what changed and why it might matter — do not re-summarise the whole page.",
    }),
  },
  {
    id: "monthly-deck",
    icon: Presentation,
    titleKey: "scheduled.tpl.monthlyDeck.title",
    blurbKey: "scheduled.tpl.monthlyDeck.blurb",
    draft: () => ({
      ...emptyDraft("prompt"),
      repeat: "weekly",
      weekday: 1,
      time: "07:00",
      body:
        "Build a short deck covering the last period from the data in <point this at a file or folder>. "
        + "One message per slide, charts only where they beat a sentence. "
        + "Open with the conclusion, not the methodology. Save it to output/ and tell me where it landed.",
    }),
  },
  {
    id: "refresh-spreadsheet",
    icon: Table2,
    titleKey: "scheduled.tpl.refreshSheet.title",
    blurbKey: "scheduled.tpl.refreshSheet.blurb",
    draft: () => ({
      ...emptyDraft("prompt"),
      repeat: "daily",
      time: "07:30",
      body:
        "Re-run the numbers in <point this at a spreadsheet or data folder> and write a refreshed copy to output/. "
        + "Keep the existing structure so I can diff it against the last one. "
        + "Flag any figure that moved more than you would expect, and any row that stopped updating.",
    }),
  },
  {
    id: "research-digest",
    icon: FileText,
    titleKey: "scheduled.tpl.researchDigest.title",
    blurbKey: "scheduled.tpl.researchDigest.blurb",
    draft: () => ({
      ...emptyDraft("prompt"),
      repeat: "weekly",
      weekday: 1,
      time: "09:00",
      body:
        "Catch me up on <the topic you are tracking>. Read the primary sources, not the commentary about them. "
        + "Tell me what is genuinely new since last week and what it changes. "
        + "If nothing important happened, say so — a short honest digest beats a padded one.",
    }),
  },
  {
    id: "dependency-sweep",
    icon: ShieldCheck,
    titleKey: "scheduled.tpl.depSweep.title",
    blurbKey: "scheduled.tpl.depSweep.blurb",
    draft: () => ({
      ...emptyDraft("prompt"),
      repeat: "weekly",
      weekday: 2,
      time: "06:00",
      body:
        "Audit this project's dependencies for known advisories and versions that have drifted badly behind. "
        + "Sort by what would actually bite us, not by severity score alone. "
        + "For each one worth acting on, say what upgrading would break. Do not change any files.",
    }),
  },
  {
    id: "health-check",
    icon: Activity,
    titleKey: "scheduled.tpl.healthCheck.title",
    blurbKey: "scheduled.tpl.healthCheck.blurb",
    draft: () => ({
      ...emptyDraft("prompt"),
      repeat: "daily",
      time: "22:00",
      body:
        "Check that <the service or endpoint you care about> is healthy and responding as expected. "
        + "Only tell me if something is wrong or trending the wrong way — silence when it is fine is the right outcome.",
    }),
  },
  {
    id: "tidy-output",
    icon: Inbox,
    titleKey: "scheduled.tpl.tidyOutput.title",
    blurbKey: "scheduled.tpl.tidyOutput.blurb",
    draft: () => ({
      ...emptyDraft("prompt"),
      repeat: "weekly",
      weekday: 0,
      time: "20:00",
      body:
        "Go through output/ and tell me what accumulated this week: what is a finished deliverable, "
        + "what is a leftover working file, and what looks abandoned half-done. "
        + "Do not delete anything — just give me the list and what you would drop.",
    }),
  },
  {
    id: "nudge",
    icon: BellRing,
    titleKey: "scheduled.tpl.nudge.title",
    blurbKey: "scheduled.tpl.nudge.blurb",
    draft: () => ({
      ...emptyDraft("reminder"),
      repeat: "weekdays",
      time: "17:30",
      body: "Wrap up: note what moved today and what tomorrow starts with.",
    }),
  },
];
