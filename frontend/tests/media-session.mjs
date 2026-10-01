// Who owns the lock screen: src/lib/mediaSession.ts against a fake navigator.mediaSession.
//
//   node tests/media-session.mjs
//
// The smoke run checks each activity on its own page; this checks the hand-offs
// between them, which need two activities in one page.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformWithOxc } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../src/lib/mediaSession.ts')
const { code } = await transformWithOxc(readFileSync(src, 'utf8'), src, { lang: 'ts' })
const dir = mkdtempSync(join(tmpdir(), 'ms-'))
const file = join(dir, 'mediaSession.mjs')
writeFileSync(file, code)

// The fake: everything the module sets, plus what it refuses (like Safari without call buttons).
const ms = { metadata: null, playbackState: 'none', handlers: {}, pos: [], mic: null }
ms.setActionHandler = (a, fn) => {
  if (a === 'togglecamera') throw new TypeError('unsupported')
  if (fn) ms.handlers[a] = fn; else delete ms.handlers[a]
}
ms.setPositionState = (p) => ms.pos.push(p ?? null)
ms.setMicrophoneActive = (on) => { ms.mic = on }
globalThis.navigator = { mediaSession: ms }
globalThis.MediaMetadata = class { constructor(m) { Object.assign(this, m) } }
let clock = 0
globalThis.performance = { now: () => clock }

const L = await import(file)
rmSync(dir, { recursive: true })

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}
const keys = () => Object.keys(ms.handlers).sort().join(',')
const noop = () => {}

const slap = (title, playing = true, at = 10) => ({ title, artist: 'Artist', playing, handlers: SLAP, position: { at, duration: 200 } })
const SLAP = { play: noop, pause: noop, nexttrack: noop, previoustrack: noop, seekto: noop }
const HUDDLE = { togglemicrophone: noop, togglecamera: noop, hangup: noop }
const huddle = (mic = true) => ({ title: 'Huddle · crcmz', playing: true, handlers: HUDDLE, position: null, mic })

L.claim('slap', slap('Song A'))
check('a claim shows its card', ms.metadata?.title === 'Song A' && ms.playbackState === 'playing' && keys() === 'nexttrack,pause,play,previoustrack,seekto')
check('no art falls back to the app icon', ms.metadata.artwork[0].src === '/app/pwa/icon-192.png' && ms.metadata.artwork[1].sizes === '512x512')
check('the scrubber is set', ms.pos.at(-1)?.position === 10 && ms.pos.at(-1)?.duration === 200)

const meta = ms.metadata, n = ms.pos.length
clock = 5000
L.update('slap', slap('Song A', true, 15))
check('an unchanged card is not rebuilt', ms.metadata === meta)
check('a scrubber that is on time is left alone', ms.pos.length === n)
L.update('slap', slap('Song A', true, 60))
check('a seek moves the scrubber', ms.pos.length === n + 1 && ms.pos.at(-1).position === 60)

L.claim('huddle', huddle())
check('the latest claim wins', ms.metadata.title === 'Huddle · crcmz' && keys() === 'hangup,togglemicrophone', keys())
check('a call has no scrubber', ms.pos.at(-1) === null)
check('the mic state reaches the OS', ms.mic === true)
L.update('slap', slap('Song B'))
check('an update from underneath does not take the lock screen', ms.metadata.title === 'Huddle · crcmz')
L.update('huddle', huddle(false))
check('muting shows on the lock screen', ms.mic === false)

L.claim('slap', slap('Song B'))
check('playing again takes it back', ms.metadata.title === 'Song B' && keys().includes('nexttrack') && !keys().includes('hangup'))
L.release('slap')
check('releasing hands it to the one before', ms.metadata.title === 'Huddle · crcmz' && keys() === 'hangup,togglemicrophone' && L.owner() === 'huddle')
L.release('slap')
check('releasing twice is harmless', L.owner() === 'huddle')
L.update('watch', { title: 'never claimed', playing: true, handlers: {} })
check('an update without a claim does nothing', ms.metadata.title === 'Huddle · crcmz' && !L.holds('watch'))
L.release('huddle')
check('the last release clears the lock screen', ms.metadata === null && ms.playbackState === 'none' && keys() === '')

L.claim('watch', { title: 'Live', playing: false, handlers: { play: noop }, position: { at: 3, duration: Infinity } })
check('a live stream gets no scrubber', ms.pos.at(-1) === null && ms.playbackState === 'paused')
L.release('watch')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
