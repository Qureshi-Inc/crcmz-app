// ST-05 · "This is mine": claim a PSN account someone linked before sign-in
// existed. Shared by Settings → PSN and Link PSN step 0.
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ConfirmDialog } from '../clips/ClipSheet'
import { toast } from '../../components/toast'
import { ApiError } from '../../lib/http'
import { claimPsn, fmtDate, type PsnUnclaimed } from '../../lib/account'

export function ClaimList({ items, onClaimed }: { items: PsnUnclaimed[]; onClaimed?: () => void }) {
  const qc = useQueryClient()
  const [pick, setPick] = useState<PsnUnclaimed | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function claim(u: PsnUnclaimed) {
    setBusy(u.key)
    try {
      await claimPsn(u.key)
      toast(`${u.online_id ?? 'That account'} is yours now`, 'success')
      onClaimed?.()
    } catch (e) {
      toast(e instanceof ApiError && e.status === 404 ? 'Someone already claimed that one' : "Couldn't claim it. Try again.", 'error')
    } finally {
      setBusy(null)
      void qc.invalidateQueries({ queryKey: ['account', 'psn'] })
    }
  }

  return (
    <>
      <ul className="rows acct-rows">
        {items.map((u) => (
          <li key={u.key} className="acct-row">
            <span className="acct-row-text">
              <span className="acct-row-title">{u.online_id ?? 'Unnamed account'}</span>
              <span className="meta">{u.mm_username ? `@${u.mm_username} · ` : ''}linked {fmtDate(u.linked_at)}</span>
            </span>
            <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => setPick(u)}>
              {busy === u.key ? 'Claiming…' : 'This is mine'}
            </button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={pick !== null} onOpenChange={(v) => { if (!v) setPick(null) }}
        title="Claim this account?"
        body={<p>{pick?.online_id ?? 'This account'} will be tied to you. Only claim the one you play on.</p>}
        action="Yes, it's mine"
        onConfirm={() => { if (pick) void claim(pick) }}
      />
    </>
  )
}
