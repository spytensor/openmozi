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

export interface SystemConfig {
  llm_providers?: Array<{ name: string; model: string; api_key_set?: boolean }>;
  language?: string;
  timezone?: string;
  log_level?: string;
  paired?: boolean;
}
