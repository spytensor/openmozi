export interface SkillInfo {
  id?: string;
  directory_name?: string;
  name: string;
  version?: string;
  category?: string;
  description: string;
  status: "active" | "disabled";
  enabled?: boolean;
  source?: "bundled" | "workspace";
  eligible?: boolean;
  missing_bins?: string[];
  missing_env?: string[];
  user_invocable?: boolean;
  origin?: string;
  sandbox_profile?: string | null;
  trigger_pattern?: string;
}

export interface SkillInstallSpec {
  kind: "brew" | "npm" | "pip" | "manual";
  formula?: string;
  package?: string;
  bins?: string[];
  label?: string;
  command?: string;
}

export interface SkillDetail extends SkillInfo {
  source: "bundled" | "workspace";
  file_path: string;
  frontmatter: {
    name: string;
    description: string;
    license?: string;
    version?: string;
    category?: string;
    "user-invocable"?: boolean;
    requires?: {
      bins?: string[];
      anyBins?: string[];
      env?: string[];
    };
    install?: SkillInstallSpec[];
    metadata?: {
      sandbox_profile?: string;
    };
  };
  content: string;
  files: Array<{ name: string; size: number }>;
}

export type AgentDefinitionStatus = "ready" | "needs-setup" | "disabled";

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  model: string | null;
  skills: string[];
  color: string | null;
  icon: string | null;
  source: "bundled" | "workspace";
  status: AgentDefinitionStatus;
  enabled: boolean;
  missing_skills: string[];
  invalid_model: string | null;
}

export interface AgentDetail extends AgentInfo {
  tools: string[];
  permission_level: "L0_READ_ONLY" | "L1_READ_WRITE" | "L2_SHELL_EXEC" | "L3_FULL_ACCESS" | null;
  persona: string;
  content: string;
}

export interface SystemConfig {
  llm_providers?: Array<{ name: string; model: string; api_key_set?: boolean }>;
  language?: string;
  timezone?: string;
  log_level?: string;
  paired?: boolean;
}
