// Live connection to the server: chat messages, typing, presence and notification pings.
// One socket per browser tab, reconnecting with back-off. Everything still works without it
// because the pages also refresh on a slow timer.
import { getToken } from './api'

const listeners = new Map() // event type -> Set<handler>
let socket = null
let retry = 0
let timer = null
let wanted = false
let online = new Set()

function emit(type, payload) {
  listeners.get(type)?.forEach((handler) => {
    try {
      handler(payload)
    } catch {
      /* one bad handler must not break the rest */
    }
  })
}

function open() {
  const token = getToken()
  if (!wanted || !token || socket) return
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${scheme}://${window.location.host}/api/ws`)
  socket = ws
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }))
  ws.onmessage = (event) => {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (data.type === 'ready' || data.type === 'presence') {
      retry = 0
      online = new Set(data.online)
      emit('presence', online)
      if (data.type === 'ready') emit('status', true)
      return
    }
    emit(data.type, data)
  }
  ws.onclose = () => {
    if (socket === ws) socket = null
    emit('status', false)
    if (!wanted) return
    retry = Math.min(retry + 1, 6)
    clearTimeout(timer)
    timer = setTimeout(open, 500 * 2 ** retry)
  }
  ws.onerror = () => ws.close()
}

export function connectRealtime() {
  wanted = true
  open()
}

export function disconnectRealtime() {
  wanted = false
  clearTimeout(timer)
  online = new Set()
  socket?.close()
  socket = null
}

/** Subscribe to an event type; returns the unsubscribe function. */
export function onRealtime(type, handler) {
  if (!listeners.has(type)) listeners.set(type, new Set())
  listeners.get(type).add(handler)
  return () => listeners.get(type)?.delete(handler)
}

export function sendRealtime(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
}

export const isRealtimeConnected = () => socket?.readyState === WebSocket.OPEN
export const onlineUsers = () => online

// Keep the connection alive through idle proxies and wake it when the tab returns.
setInterval(() => sendRealtime({ type: 'ping' }), 30000)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && open())
}
