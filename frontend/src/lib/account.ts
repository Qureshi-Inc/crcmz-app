// Account routes for Settings (PS-10), Link PSN (PS-12) and Admin (PS-11). The
// server side is untouched: these only consume the routes the classic app uses.
import { request } from './http'

export type Passkey = { id: string; name: string }

export type PsnUnclaimed = { key: string; online_id: string | null; mm_username: string | null; linked_at: number | null }
export type PsnAccount = {
  key?: string
  zitadel_user_id: string | null
  mm_username: string | null
  online_id: string | null
  account_id: string | null
  linked_at: number | null
  refresh_expires_at: number | null
}
export type PsnStatus =
  | { linked: true; online_id: string | null; linked_at: number | null; token_ok?: boolean; npsso_ok?: boolean; refresh_expires_at: number | null; admin?: boolean; users?: PsnAccount[] }
  | { linked: false; unclaimed?: PsnUnclaimed[]; admin?: boolean; users?: PsnAccount[] }

export type MmStatus = { linked: boolean; linked_at: number | null; connect_available: boolean }
export type SteamStatus = {
  linked: boolean; steam_id: string | null; persona_name: string | null; avatar: string | null
  profile_url: string | null; connect_available: boolean
  has_psn: boolean; primary: 'psn' | 'steam'; games_private?: boolean
}
export type ProfileStatus = { squad_name: string; default_name: string; min: number; max: number }
export type McpStatus = { active: boolean; last_used_at: number | null }

export type AdminUser = { userId: string; userName: string; displayName: string; email: string; state: string }

export type ServiceHealth = { status: 'ok' | 'error' | 'down'; ms: number | null }
export type PipelineHealth = { services: Record<string, ServiceHealth> }
export type OpsStatus = {
  psn: string; whatsapp: string; clip_store: string; groups: number; queue_depth: number
  clips_total: number; clips_delivered: number; clips_archived: number; clips_failed: number; clips_active: number
}
export type VideoJobs = { stats: { total?: number; delivered?: number; failed?: number; archived?: number; active?: number }; queue_depth: number }

// ── PSN token state (ST-04) ────────────────────────────────────────────────────
export type TokenState = { kind: 'active' | 'expiring' | 'expired' | 'unknown'; days: number | null; label: string }

const DAY = 86_400
export function tokenState(r: { token_ok?: boolean; refresh_expires_at: number | null }, nowSec = Date.now() / 1000): TokenState {
  const exp = r.refresh_expires_at
  if (r.token_ok === false || (exp != null && exp <= nowSec)) return { kind: 'expired', days: 0, label: 'Expired' }
  if (exp == null) return r.token_ok ? { kind: 'active', days: null, label: 'Active' } : { kind: 'unknown', days: null, label: 'Unknown' }
  const days = Math.max(1, Math.ceil((exp - nowSec) / DAY))
  if (exp - nowSec <= 7 * DAY) return { kind: 'expiring', days, label: `Expiring in ${days} day${days === 1 ? '' : 's'}` }
  return { kind: 'active', days, label: 'Active' }
}

export const fmtDate = (sec: number | null | undefined) =>
  sec ? new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
export const fmtDateTime = (sec: number | null | undefined) =>
  sec ? new Date(sec * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'never'

// ── Passkeys (WebAuthn), byte-for-byte the classic app's encoding ─────────────
function b64url(buf: ArrayBuffer): string {
  let s = ''
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}
function fromB64url(s: string): ArrayBuffer {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  return Uint8Array.from(atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer
}

export const passkeysSupported = () => typeof window !== 'undefined' && 'PublicKeyCredential' in window

/** Resolves false when the person cancels the browser prompt (not an error). */
export async function addPasskey(): Promise<boolean> {
  if (!passkeysSupported()) throw new Error("This browser can't make passkeys")
  type Begin = { passkeyId: string; options: Record<string, any> }
  const { passkeyId, options } = await request<Begin>('/auth/passkey/register/begin', { method: 'POST', timeoutMs: 20_000 })
  const o = { ...options }
  o.challenge = fromB64url(o.challenge)
  o.user = { ...o.user, id: fromB64url(o.user.id) }
  if (o.excludeCredentials) o.excludeCredentials = o.excludeCredentials.map((c: { id: string }) => ({ ...c, id: fromB64url(c.id) }))
  let cred: PublicKeyCredential | null
  try {
    cred = (await navigator.credentials.create({ publicKey: o as PublicKeyCredentialCreationOptions })) as PublicKeyCredential | null
  } catch (e) {
    if ((e as Error)?.name === 'NotAllowedError' || (e as Error)?.name === 'AbortError') return false
    throw e
  }
  if (!cred) return false
  const res = cred.response as AuthenticatorAttestationResponse
  const credential = {
    id: cred.id, rawId: b64url(cred.rawId), type: cred.type,
    response: { clientDataJSON: b64url(res.clientDataJSON), attestationObject: b64url(res.attestationObject) },
  }
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const passkeyName = `${nav.userAgentData?.platform || navigator.platform || 'Device'} passkey`
  await request('/auth/passkey/register/complete', { body: { passkeyId, credential, passkeyName }, timeoutMs: 20_000 })
  return true
}

export const removePasskey = (id: string) => request<{ ok: boolean }>(`/auth/settings/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const changePassword = (currentPassword: string, newPassword: string) =>
  request<{ ok: boolean }>('/auth/settings/password', { body: { currentPassword, newPassword } })
export const claimPsn = (key: string) => request<{ ok: boolean }>('/auth/settings/psn/claim', { body: { key } })
/** Sony's sign-in can be slow; the link call waits on it. */
export const linkPsn = (npsso: string) => request<{ ok: boolean; online_id?: string }>('/api/psn/link', { body: { npsso }, timeoutMs: 45_000 })
export const unlinkMattermost = () => request<{ ok: boolean }>('/auth/settings/mattermost/unlink', { method: 'POST' })
export const unlinkSteam = () => request<{ ok: boolean }>('/auth/settings/steam/unlink', { method: 'POST' })
export const setSquadName = (name: string) =>
  request<{ ok: boolean; squad_name: string }>('/auth/settings/squad-name', { body: { name } })
export const setPrimaryPlatform = (platform: 'psn' | 'steam') =>
  request<{ ok: boolean; primary: string }>('/auth/settings/primary-platform', { body: { platform } })
export const revokeMcp = () => request<{ ok: boolean }>('/auth/settings/mcp/revoke', { method: 'POST' })
export const resetUserPassword = (id: string, newPassword: string) =>
  request<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, { body: { newPassword } })

export type Invite = {
  id: number; email: string; kind: string; status: string; error: string; source: string
  gamer_tag: string; mm_username: string; created_at: string; accepted_at: string | null
}
export type InviteResult = { ok: boolean; kind: string; zitadel_id: string; mm_username?: string; duplicate?: boolean }
/** Account + branded email; the member picks their username on the invite page. SMTP can be slow. */
export const inviteMember = (body: { email: string; name: string; vip: boolean }) =>
  request<InviteResult>('/api/invites/vip', { body: { ...body, source: 'admin' }, timeoutMs: 45_000 })

export const MCP_URL = 'https://app.crcmz.me/mcp'
export const MCP_CONFIG = JSON.stringify({ mcpServers: { crcmz: { type: 'http', url: MCP_URL } } }, null, 2)
