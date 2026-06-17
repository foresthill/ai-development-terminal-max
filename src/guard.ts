// Guardrail deny-list presets. These are *opinions*, not baked-in policy — the
// user toggles them in Settings, so the tool ships neutral and stays OSS-friendly.
// Deny syntax: space-glob, e.g. `Bash(git push origin main)`.
// https://code.claude.com/docs/en/permissions.md
export interface GuardPreset {
  id: string;
  label: string; // i18n key, resolved via t() at render time
  rules: string[];
}

export const GUARD_PRESETS: GuardPreset[] = [
  {
    id: "push-main",
    label: "guard.pushMain",
    rules: ["Bash(git push origin main)", "Bash(git push origin master)"],
  },
  {
    id: "force-push",
    label: "guard.forcePush",
    rules: ["Bash(git push -f *)", "Bash(git push --force *)", "Bash(git push --force-with-lease *)"],
  },
  { id: "sudo", label: "guard.sudo", rules: ["Bash(sudo *)"] },
  { id: "net", label: "guard.net", rules: ["Bash(curl *)", "Bash(wget *)"] },
];

/// Flatten the enabled presets plus any custom lines into the effective deny list.
export function effectiveDeny(enabled: Set<string>, custom: string): string[] {
  const out: string[] = [];
  for (const p of GUARD_PRESETS) if (enabled.has(p.id)) out.push(...p.rules);
  for (const line of custom.split("\n").map((l) => l.trim()).filter(Boolean)) out.push(line);
  return out;
}
