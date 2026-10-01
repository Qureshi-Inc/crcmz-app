// Watch Party and Huddle can both be live at once (F-5). Each call registers its
// mic here, so joining one can mute your mic in the other: one live mic at a time.
type CallMic = { label: string; live: () => boolean; mute: () => void }

const calls = new Map<string, CallMic>()

export function registerCall(id: string, mic: CallMic) {
  calls.set(id, mic)
}

/** Mutes every other call's live mic; returns the labels of the calls it muted. */
export function muteOtherCalls(id: string): string[] {
  const muted: string[] = []
  calls.forEach((c, k) => {
    if (k !== id && c.live()) { c.mute(); muted.push(c.label) }
  })
  return muted
}
