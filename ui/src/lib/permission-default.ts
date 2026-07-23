import type { PermissionLevel } from "@/components/chat/PermissionChip";

export const DEFAULT_PERMISSION_STORAGE_KEY = "mozi.ui.defaultPermissionLevel";

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return (
    value === "L0_READ_ONLY" ||
    value === "L1_READ_WRITE" ||
    value === "L2_SHELL_EXEC" ||
    value === "L3_FULL_ACCESS"
  );
}

export function readDefaultPermissionLevel(): PermissionLevel | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(DEFAULT_PERMISSION_STORAGE_KEY);
    return isPermissionLevel(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function writeDefaultPermissionLevel(level: PermissionLevel) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DEFAULT_PERMISSION_STORAGE_KEY, level);
  } catch {
    // The selected default still applies in-memory during onboarding.
  }
}
