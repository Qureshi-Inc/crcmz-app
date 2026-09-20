import { api } from './http'

/**
 * Shared and personal chat boards.
 *
 * Two boards, two endpoint families, same button shape. The shared board is visible to
 * everyone and sends as the bot; the personal board is per-Zitadel-user and requires a
 * session (the backend 401s otherwise, which is the authority — the UI only avoids
 * offering what will fail).
 */

export interface BoardButton {
  label: string
  msg: string
  /** Colour class name chosen by the backend. Mapped, never injected as CSS. */
  cls: string | null
  custom: boolean
}

function parseButtons(raw: unknown): BoardButton[] {
  const root = (raw ?? {}) as { buttons?: unknown }
  const list = Array.isArray(root.buttons) ? root.buttons : []
  return list.flatMap((item): BoardButton[] => {
    const b = (item ?? {}) as Record<string, unknown>
    const msg = typeof b.msg === 'string' ? b.msg : ''
    // A button with no message would post an empty line to a real group.
    if (!msg.trim()) return []
    return [{
      msg,
      label: typeof b.label === 'string' && b.label ? b.label : msg.slice(0, 22),
      cls: typeof b.cls === 'string' ? b.cls : null,
      custom: b.custom === true,
    }]
  })
}

export const getSharedBoard = (signal?: AbortSignal) =>
  api.get<BoardButton[]>('/api/soundboard', { signal, parse: parseButtons })

export const getPersonalBoard = (signal?: AbortSignal) =>
  api.get<BoardButton[]>('/api/soundboard/personal', { signal, parse: parseButtons })

export interface AddButtonResult {
  button: BoardButton | null
  flavored: string
  sent: boolean
}

/**
 * Add a button. The backend runs the text through the flavour model, so the label the
 * user gets back is not the text they typed — the UI has to show what was actually
 * saved rather than echo the input.
 *
 * `send: false` because adding a button and firing it at a real PSN group are two
 * different intentions, and the legacy board conflated them: creating a button posted
 * it immediately with no way to say no.
 */
export function addButton(
  text: string,
  opts: { personal: boolean; send?: boolean },
  signal?: AbortSignal,
) {
  return api.post<AddButtonResult>(
    opts.personal ? '/api/soundboard/personal' : '/api/soundboard',
    { text, send: opts.send ?? false },
    {
      signal,
      // The flavour model is a local LLM and is not fast.
      timeoutMs: 60_000,
      parse: (raw): AddButtonResult => {
        const r = (raw ?? {}) as Record<string, unknown>
        const buttons = parseButtons({ buttons: [r.button] })
        return {
          button: buttons[0] ?? null,
          flavored: typeof r.flavored === 'string' ? r.flavored : '',
          sent: r.sent === true,
        }
      },
    },
  )
}

/**
 * Remove a button.
 *
 * Keyed on the message text, not the label: both delete handlers filter on
 * `b["msg"] != req.text`, and the label is a truncated preview of the message, so
 * sending the label would delete nothing and report success.
 */
export function deleteButton(msg: string, opts: { personal: boolean }, signal?: AbortSignal) {
  return api.post<{ removed: number }>(
    opts.personal ? '/api/soundboard/personal/delete' : '/api/soundboard/delete',
    { text: msg, send: false },
    {
      signal,
      parse: (raw): { removed: number } => {
        const removed = (raw as { removed?: unknown })?.removed
        return { removed: typeof removed === 'number' ? removed : 0 }
      },
    },
  )
}

/** Persist a personal board order. The server takes the full label list. */
export function reorderPersonal(labels: string[], signal?: AbortSignal) {
  return api.post<{ status?: string }>('/api/soundboard/personal/order', { labels }, { signal })
}
