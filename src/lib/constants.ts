import type { Role } from '@/types/database'

/** Team roles, for display (0001). */
export const ROLES: { value: Role; label: string }[] = [
  { value: 'manager', label: 'Manager' },
  { value: 'member', label: 'Team member' },
]

export const roleLabel = (v: Role): string => ROLES.find((r) => r.value === v)?.label ?? 'Team member'
