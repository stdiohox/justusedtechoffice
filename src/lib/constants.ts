import type { Role } from '@/types/database'

/** Team roles, for display (0001). */
export const ROLES: { value: Role; label: string }[] = [
  { value: 'manager', label: 'Manager' },
  { value: 'member', label: 'Team member' },
]

export const roleLabel = (v: Role): string => ROLES.find((r) => r.value === v)?.label ?? 'Team member'

/**
 * What someone is shown as: their job title (0016: "CEO", "Operations
 * Manager"), or, with none set, their team role as before.
 */
export const titleOf = (p: { role: Role; job_title?: string | null }): string => p.job_title?.trim() || roleLabel(p.role)
