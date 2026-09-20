import { api } from './http'

/**
 * Account settings: PSN link, Mattermost, MCP access, passkeys.
 *
 * Every one of these 401s for a signed-out browser and several are admin-gated
 * server-side, so the UI reads the status and offers only what the status says is
 * possible — the endpoints stay the authority.
 *
 * Passkey *registration* is deliberately not here. It is a WebAuthn ceremony against
 * /auth/passkey/register/begin and /complete with base64url-encoded challenge material,
 * and getting it subtly wrong produces a credential that cannot be used to sign in. The
 * working implementation lives in the classic interface; this screen links to it rather
 * than reimplementing a security ceremony untested. See docs/ux/INVENTORY.md.
 */

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

export interface PsnStatus {
  linked: boolean
  onlineId: string | null
  /**
   * PSN accounts nobody has claimed, offered for the user to pick from. `key` is the
   * record's filename stem and is what /claim takes — not the online id.
   */
  unclaimed: { key: string; onlineId: string }[]
  isAdmin: boolean
}

export function getPsnStatus(signal?: AbortSignal) {
  return api.get<PsnStatus>('/auth/settings/psn', {
    signal,
    timeoutMs: 20_000,
    parse: (raw): PsnStatus => {
      const r = (raw ?? {}) as Record<string, unknown>
      const unclaimed = Array.isArray(r.unclaimed) ? r.unclaimed : []
      return {
        linked: r.linked === true,
        // When linked, the whole portal record is spread into the response, so the id is
        // a top-level field rather than nested.
        onlineId: str(r.online_id),
        isAdmin: r.admin === true,
        unclaimed: unclaimed.flatMap(item => {
          const u = (item ?? {}) as Record<string, unknown>
          const key = str(u.key)
          // No key means it cannot be claimed, so there is nothing to offer.
          return key ? [{ key, onlineId: str(u.online_id) ?? key }] : []
        }),
      }
    },
  })
}

/** `key` is the record key from `unclaimed`, which is what the handler reads. */
export const claimPsn = (key: string, signal?: AbortSignal) =>
  api.post<{ status?: string }>('/auth/settings/psn/claim', { key }, {
    signal,
    timeoutMs: 20_000,
  })

export interface MattermostStatus {
  linked: boolean
  username: string | null
  linkedAt: string | null
}

export function getMattermostStatus(signal?: AbortSignal) {
  return api.get<MattermostStatus>('/auth/settings/mattermost', {
    signal,
    parse: (raw): MattermostStatus => {
      const r = (raw ?? {}) as Record<string, unknown>
      return {
        linked: r.linked === true,
        username: str(r.username) ?? str(r.mm_username),
        linkedAt: str(r.linked_at) ?? (typeof r.linked_at === 'number' ? String(r.linked_at) : null),
      }
    },
  })
}

export const unlinkMattermost = (signal?: AbortSignal) =>
  api.post<{ status?: string }>('/auth/settings/mattermost/unlink', undefined, { signal })

export interface McpStatus {
  active: boolean
  lastUsedAt: number | null
}

export function getMcpStatus(signal?: AbortSignal) {
  return api.get<McpStatus>('/auth/settings/mcp', {
    signal,
    parse: (raw): McpStatus => {
      const r = (raw ?? {}) as Record<string, unknown>
      return {
        active: r.active === true,
        lastUsedAt: typeof r.last_used_at === 'number' ? r.last_used_at : null,
      }
    },
  })
}

export const revokeMcp = (signal?: AbortSignal) =>
  api.post<{ status?: string }>('/auth/settings/mcp/revoke', undefined, { signal })

export interface Passkey {
  id: string
  name: string
}

export function getPasskeys(signal?: AbortSignal) {
  return api.get<Passkey[]>('/auth/settings/passkeys', {
    signal,
    parse: (raw): Passkey[] => {
      const root = (raw ?? {}) as Record<string, unknown>
      const list = Array.isArray(root.passkeys) ? root.passkeys : []
      return list.flatMap(item => {
        const p = (item ?? {}) as Record<string, unknown>
        const id = str(p.id)
        return id ? [{ id, name: str(p.name) ?? 'Passkey' }] : []
      })
    },
  })
}

export const deletePasskey = (id: string, signal?: AbortSignal) =>
  api.del<{ status?: string }>(`/auth/settings/passkeys/${encodeURIComponent(id)}`, { signal })

/**
 * Change your own password. Zitadel requires the current one, and the handler reads
 * camelCase keys — `currentPassword` and `newPassword`, not snake_case.
 */
export const setPassword = (currentPassword: string, newPassword: string, signal?: AbortSignal) =>
  api.post<{ status?: string }>(
    '/auth/settings/password',
    { currentPassword, newPassword },
    { signal, timeoutMs: 20_000 },
  )

/* ── Admin ─────────────────────────────────────────────────────────────────── */

export interface AdminUser {
  id: string
  email: string
  state: string | null
  displayName: string | null
}

export function getUsers(signal?: AbortSignal) {
  return api.get<AdminUser[]>('/api/admin/users', {
    signal,
    timeoutMs: 20_000,
    parse: (raw): AdminUser[] => {
      const root = (raw ?? {}) as Record<string, unknown>
      const list = Array.isArray(root.users) ? root.users : []
      return list.flatMap(item => {
        const u = (item ?? {}) as Record<string, unknown>
        const id = str(u.id) ?? str(u.userId)
        if (!id) return []
        return [{
          id,
          email: str(u.email) ?? '',
          state: str(u.state),
          displayName: str(u.display_name) ?? str(u.displayName) ?? str(u.name),
        }]
      })
    },
  })
}

/** Admin reset: no current password, and the server enforces a minimum of 8 characters. */
export const resetUserPassword = (userId: string, newPassword: string, signal?: AbortSignal) =>
  api.post<{ status?: string }>(
    `/api/admin/users/${encodeURIComponent(userId)}/reset-password`,
    { newPassword },
    { signal, timeoutMs: 20_000 },
  )
