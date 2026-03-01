export const AGENT_ROLES = [
  { id: "lead_engineer", label: "Lead Engineer", color: "blue", defaultSprite: 1 },
  { id: "tester", label: "Tester", color: "green", defaultSprite: 5 },
  { id: "code_reviewer", label: "Code Reviewer", color: "purple", defaultSprite: 7 },
  { id: "architect", label: "Architect", color: "amber", defaultSprite: 4 },
  { id: "security_reviewer", label: "Security Reviewer", color: "red", defaultSprite: 3 },
  { id: "researcher", label: "Researcher", color: "indigo", defaultSprite: 2 },
  { id: "devops", label: "DevOps", color: "orange", defaultSprite: 8 },
  { id: "designer", label: "Designer", color: "pink", defaultSprite: 9 },
  { id: "planner", label: "Planner", color: "teal", defaultSprite: 10 },
] as const;

export type AgentRoleId = (typeof AGENT_ROLES)[number]["id"];

export const ROLE_MAP = Object.fromEntries(
  AGENT_ROLES.map((r) => [r.id, r])
) as Record<AgentRoleId, (typeof AGENT_ROLES)[number]>;

const ROLE_COLOR_CLASSES: Record<string, string> = {
  blue: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  green: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  purple: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300",
  red: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
  indigo: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300",
  orange: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
  pink: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-300",
  teal: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-300",
};

export function getRoleColorClass(roleId: string | null): string {
  if (!roleId) return "";
  const role = ROLE_MAP[roleId as AgentRoleId];
  if (!role) return "";
  return ROLE_COLOR_CLASSES[role.color] ?? "";
}

export function getRoleLabel(roleId: string | null): string | null {
  if (!roleId) return null;
  return ROLE_MAP[roleId as AgentRoleId]?.label ?? null;
}
