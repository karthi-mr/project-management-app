import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { api, onChanged } from '../api'
import { Modal, Spinner, dayToDate, dayToISO, formatDate, parseDay, todayDay } from '../ui'
import DeadlineList, { KIND_META, useOpenDeadline } from '../components/Deadlines'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MAX_PER_DAY = 3

export default function Calendar() {
  const openDeadline = useOpenDeadline()
  const now = new Date()
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() })
  const [items, setItems] = useState(null)
  const [projects, setProjects] = useState([])
  const [projectId, setProjectId] = useState('')
  const [hideDone, setHideDone] = useState(false)
  const [error, setError] = useState('')
  const [dayModal, setDayModal] = useState(null)
  const today = todayDay()

  // Six-week grid starting on the Monday on or before the 1st.
  const first = Date.UTC(cursor.year, cursor.month, 1) / 86400000
  const gridStart = first - ((dayToDate(first).getUTCDay() + 6) % 7)
  const gridEnd = gridStart + 41

  useEffect(() => {
    api('/projects').then(setProjects).catch(() => {})
  }, [])

  useEffect(() => {
    const load = () => {
      const query = `start=${dayToISO(gridStart)}&end=${dayToISO(gridEnd)}${projectId ? `&project_id=${projectId}` : ''}`
      api(`/schedule?${query}`).then(setItems).catch((e) => setError(e.message))
    }
    load()
    return onChanged(load)
  }, [gridStart, gridEnd, projectId])

  const byDay = useMemo(() => {
    const map = new Map()
    for (const item of items || []) {
      if (hideDone && item.done) continue
      if (!map.has(item.date)) map.set(item.date, [])
      map.get(item.date).push(item)
    }
    return map
  }, [items, hideDone])

  const move = (delta) =>
    setCursor(({ year, month }) => {
      const d = new Date(year, month + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })

  const monthItems = (items || []).filter((i) => !i.done && dayToDate(parseDay(i.date)).getUTCMonth() === cursor.month)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Calendar</h1>
          <p>Deadlines for projects, milestones and issues.</p>
        </div>
      </div>

      <div className="toolbar">
        <button className="btn btn-icon" onClick={() => move(-1)} aria-label="Previous month"><ChevronLeft size={16} /></button>
        <button className="btn btn-icon" onClick={() => move(1)} aria-label="Next month"><ChevronRight size={16} /></button>
        <h2 style={{ minWidth: 150 }}>{MONTHS[cursor.month]} {cursor.year}</h2>
        <button className="btn btn-sm" onClick={() => setCursor({ year: now.getFullYear(), month: now.getMonth() })}>Today</button>
        <span className="grow" />
        <span className="small muted hide-mobile">{monthItems.length} open deadline{monthItems.length === 1 ? '' : 's'} this month</span>
        <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {projects.filter((p) => p.status !== 'archived').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label className="check-item small">
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide completed
        </label>
      </div>

      {error && <div className="form-error">{error}</div>}
      {!items && !error ? <Spinner page /> : (
        <div className="card cal">
          <div className="cal-head">{WEEKDAYS.map((d) => <div key={d}>{d}</div>)}</div>
          <div className="cal-grid">
            {Array.from({ length: 42 }, (_, n) => {
              const day = gridStart + n
              const iso = dayToISO(day)
              const date = dayToDate(day)
              const list = byDay.get(iso) || []
              return (
                <div key={day} className={`cal-cell ${date.getUTCMonth() !== cursor.month ? 'other' : ''} ${day === today ? 'today' : ''}`}>
                  <span className="cal-date">{date.getUTCDate()}</span>
                  {list.slice(0, MAX_PER_DAY).map((item) => {
                    const Icon = KIND_META[item.kind].icon
                    return (
                      <button
                        key={`${item.kind}-${item.id}`}
                        className={`cal-item ${item.kind} ${item.done ? 'done' : ''} ${!item.done && day < today ? 'overdue' : ''}`}
                        style={{ '--c': item.color }}
                        title={`${KIND_META[item.kind].label}: ${item.key ? `${item.key} ` : ''}${item.title} — ${item.project_name}`}
                        onClick={() => openDeadline(item)}
                      >
                        {item.kind !== 'issue' && <Icon size={11} strokeWidth={2.5} />}
                        <span className="truncate">{item.title}</span>
                      </button>
                    )
                  })}
                  {list.length > MAX_PER_DAY && (
                    <button className="cal-more" onClick={() => setDayModal({ iso, list })}>+{list.length - MAX_PER_DAY} more</button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {dayModal && (
        <Modal title={formatDate(dayModal.iso, true)} onClose={() => setDayModal(null)} size="sm">
          <div className="modal-body" onClick={() => setDayModal(null)}>
            <DeadlineList items={dayModal.list} />
          </div>
        </Modal>
      )}
    </div>
  )
}
