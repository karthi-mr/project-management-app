import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck } from 'lucide-react'
import { api, onChanged } from '../api'
import { onRealtime } from '../realtime'
import { relativeDay, timeAgo, useOpenIssue } from '../ui'
import { KindIcon, useOpenDeadline } from './Deadlines'

const POLL_MS = 60000
const SEVERITY_LABEL = { overdue: 'Overdue', today: 'Due today', soon: 'Due soon', info: 'Action needed' }

export default function NotificationBell() {
  const navigate = useNavigate()
  const openIssue = useOpenIssue()
  const openDeadline = useOpenDeadline()
  const [data, setData] = useState({ pending: [], updates: [], unread: 0, count: 0 })
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)

  const load = useCallback(() => {
    api('/notifications').then(setData).catch(() => {})
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    const onFocus = () => document.visibilityState === 'visible' && load()
    document.addEventListener('visibilitychange', onFocus)
    const off = onChanged(load)
    const offLive = onRealtime('notify', load)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onFocus)
      off()
      offLive()
    }
  }, [load])

  useEffect(() => {
    if (!open) return
    const onClick = (e) => !boxRef.current?.contains(e.target) && setOpen(false)
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const openPending = (item) => {
    setOpen(false)
    openDeadline(item)
  }

  const openUpdate = async (note) => {
    setOpen(false)
    if (!note.is_read) {
      api(`/notifications/${note.id}/read`, { method: 'POST' }).then(load).catch(() => {})
    }
    if (note.conversation_id) navigate(`/chat?c=${note.conversation_id}`)
    else if (note.issue_id) openIssue(note.issue_id)
    else if (note.feature_id && note.project_id) navigate(`/projects/${note.project_id}?tab=features&feature=${note.feature_id}`)
    else if (note.project_id) navigate(`/projects/${note.project_id}`)
  }

  const markAllRead = () => api('/notifications/read-all', { method: 'POST' }).then(load).catch(() => {})

  const empty = data.pending.length === 0 && data.updates.length === 0

  return (
    <div className="bell" ref={boxRef}>
      <button
        className="btn btn-icon btn-ghost"
        onClick={() => setOpen((o) => !o)}
        aria-label={data.count ? `Notifications, ${data.count} need attention` : 'Notifications'}
        aria-expanded={open}
      >
        <Bell size={18} />
      </button>
      {data.count > 0 && <span className="bell-count">{data.count > 99 ? '99+' : data.count}</span>}

      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="bell-head">
            <h3>Notifications</h3>
            {data.unread > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={markAllRead}><CheckCheck size={14} /> Mark all read</button>
            )}
          </div>

          {empty && (
            <div className="empty" style={{ padding: '36px 20px' }}>
              <div className="empty-icon"><Bell size={22} /></div>
              <h3>You're all caught up</h3>
              <p className="small">Overdue work, upcoming deadlines and updates from your team will appear here.</p>
            </div>
          )}

          {data.pending.length > 0 && (
            <>
              <div className="bell-section">Needs attention <span>{data.pending.length}</span></div>
              {data.pending.map((item) => (
                <button className="bell-item" key={`${item.kind}-${item.id}-${item.severity}`} onClick={() => openPending(item)}>
                  <KindIcon kind={item.kind} color={item.color} />
                  <span className="grow">
                    <div style={{ fontWeight: 550, overflowWrap: 'anywhere' }}>{item.title}</div>
                    <div className="small faint">
                      {item.project_name}
                      {item.project_name && item.date && ' · '}
                      {item.date && relativeDay(item.date)}
                    </div>
                  </span>
                  <span className={`sev ${item.severity}`}>{SEVERITY_LABEL[item.severity]}</span>
                </button>
              ))}
            </>
          )}

          {data.updates.length > 0 && (
            <>
              <div className="bell-section">Updates {data.unread > 0 && <span>{data.unread} new</span>}</div>
              {data.updates.map((note) => (
                <button className={`bell-item ${note.is_read ? '' : 'unread'}`} key={note.id} onClick={() => openUpdate(note)}>
                  <span className={`bell-dot ${note.is_read ? 'read' : ''}`} />
                  <span className="grow">
                    <div style={{ overflowWrap: 'anywhere' }}>{note.message}</div>
                    <div className="small faint">{timeAgo(note.created_at)}</div>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
