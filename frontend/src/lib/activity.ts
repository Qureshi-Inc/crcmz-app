import { request } from './http'

let _pingIv = 0
let _current: { type: string; room: string } | null = null

export function startActivity(type: 'huddle' | 'watch' | 'together' | 'slap', room = '') {
  _current = { type, room }
  void request('/api/activity/ping', { body: { type, room }, quiet401: true })
  if (!_pingIv) _pingIv = window.setInterval(() => {
    if (_current) void request('/api/activity/ping', { body: _current, quiet401: true })
  }, 60_000)
}

export function stopActivity(type: 'huddle' | 'watch' | 'together' | 'slap') {
  if (_current?.type !== type) return
  _current = null
  if (_pingIv) { window.clearInterval(_pingIv); _pingIv = 0 }
  void request('/api/activity/clear', { method: 'POST', quiet401: true })
}

export type ActivitySession = { name: string; type: string; room: string }
export type ActivityData = { sessions: ActivitySession[] }
