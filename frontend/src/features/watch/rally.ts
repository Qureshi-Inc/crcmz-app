// Rally: everyone's phone rings into the Watch Party (a full-screen call on the Android
// app, a high-priority push elsewhere) and the WhatsApp group gets "@all … join now".
import { ApiError } from '../../lib/http'
import { ringSquad } from '../../lib/ring'
import { rally } from './session'

/** Both at once; returns the line to show. ringSquad toasts the ring on its own. */
export async function rallyEveryone(): Promise<string> {
  const [wa] = await Promise.allSettled([rally(), ringSquad('watch')])
  if (wa.status === 'fulfilled') return "Rally sent: everyone's phone is ringing and the WhatsApp group knows"
  const why = wa.reason instanceof ApiError && wa.reason.detail ? ` (${wa.reason.detail})` : ''
  return `Phones are ringing, but the WhatsApp post didn't go${why}`
}
