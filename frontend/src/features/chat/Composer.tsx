// CB-10 · quick message, sent as the user via POST /v2/send. Not saved, no AI.
// The draft survives failure, a reload and a sign-in round trip; it clears only on Sent.
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAccount, useSquad } from '../../lib/api'
import { readLocal, writeLocal } from '../../lib/media'
import { notSentToast, SEND_LABEL, slowLabel, slowToast, UNKNOWN_INLINE } from '../../lib/send'
import { usePsnControl } from './usePsnControl'

const DRAFT_KEY = 'crcmz_app_quick_draft'

export function Composer({ onSent }: { onSent: (text: string, avatar: string | null) => void }) {
  const [draft, setDraft] = useState<string>(() => {
    const v = readLocal<unknown>(DRAFT_KEY, '')
    return typeof v === 'string' ? v : ''
  })
  const [unknownFor, setUnknownFor] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const ctl = usePsnControl('composer')
  const account = useAccount()
  const squad = useSquad()

  useEffect(() => { writeLocal(DRAFT_KEY, draft) }, [draft])

  const text = draft.trim()
  const again = unknownFor !== null && unknownFor === text

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!text || ctl.locked) return
    setRefused(null)
    const out = await ctl.fire('/v2/send', { message: text }, { sentAnnouncement: `Sent: ${text}` })
    if (!out) return
    if (out.kind === 'sent') {
      setDraft('')
      setUnknownFor(null)
      const me = account.data?.state === 'signed-in' && account.data.onlineId
        ? squad.data?.squad.find((m) => (m.online_id || '').toLowerCase() === (account.data as { onlineId: string }).onlineId.toLowerCase())
        : undefined
      onSent(text, me?.avatar ?? null)
    } else if (out.kind === 'unknown') {
      setUnknownFor(text)
    } else if (out.kind === 'notsent') {
      setUnknownFor(null)
      setRefused(notSentToast(out.status, out.reason))
    }
  }

  let label = 'Send'
  if (ctl.state === 'sending') label = SEND_LABEL.sending
  else if (ctl.state === 'countdown') label = slowLabel(ctl.cooldown)
  else if (ctl.state === 'sent') label = SEND_LABEL.sent
  else if (again) label = 'Send again anyway'
  else if (ctl.state === 'notsent') label = SEND_LABEL.notsent

  let msg: { tone: string; text: string } | null = null
  if (ctl.state === 'countdown') msg = { tone: 'countdown', text: slowToast(ctl.cooldown) }
  else if (again) msg = { tone: 'unknown', text: UNKNOWN_INLINE }
  else if (refused) msg = { tone: 'error', text: refused }

  const notLinked = account.data?.state === 'signed-in' && !account.data.linked
  const dataSend = ctl.state === 'idle' && again ? 'unknown' : ctl.state

  return (
    <form className="composer" onSubmit={submit}>
      <label className="field-label" htmlFor="quick-message">Quick message</label>
      <div className="composer-row">
        <input
          id="quick-message"
          className="input"
          type="text"
          autoComplete="off"
          enterKeyHint="send"
          maxLength={500}
          placeholder="Message the squad…"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setRefused(null) }}
        />
        <button
          type="submit"
          className="btn btn-cyan send-btn"
          data-send={dataSend}
          aria-busy={ctl.busy || undefined}
          aria-disabled={ctl.locked || !text || undefined}
        >
          {label}
        </button>
      </div>
      <div aria-live="polite">
        {msg && <p className="composer-msg" data-tone={msg.tone}>{msg.text}</p>}
      </div>
      {notLinked && (
        <p className="composer-note">
          Sends as crcmz-mod until you link PSN. <Link to="/portal">Link PSN</Link>
        </p>
      )}
    </form>
  )
}
