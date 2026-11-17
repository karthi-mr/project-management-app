import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Clock, Download } from 'lucide-react'
import { api, onChanged } from '../api'
import { useAuth } from '../context'
import { Empty, PageSkeleton, dayToDate, dayToISO, downloadCsv, formatDate, todayDay, useOpenIssue } from '../ui'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const hours = (n) => (n ? `${Math.round(n * 100) / 100}h` : '')

export default function Timesheet() {
  const { user } = useAuth()
  const openIssue = useOpenIssue()
  const today = todayDay()
  const mondayOf = (day) => day - ((dayToDate(day).getUTCDay() + 6) % 7)
  const [weekStart, setWeekStart] = useState(() => mondayOf(today))
  const [personId, setPersonId] = useState('')
  const [people, setPeople] = useState([])
  const [entries, setEntries] = useState(null)
  const [error, setError] = useState('')
  const isAdmin = user.role === 'admin'

  useEffect(() => {
    if (isAdmin) api('/users').then((rows) => setPeople(rows.filter((u) => u.is_active !== false))).catch(() => {})
  }, [isAdmin])

  useEffect(() => {
    const load = () =>
      api(`/timesheet?start=${dayToISO(weekStart)}&end=${dayToISO(weekStart + 6)}${personId ? `&user_id=${personId}` : ''}`)
        .then((rows) => {
          setEntries(rows)
          setError('')
        })
        .catch((e) => setError(e.message))
    load()
    return onChanged(load)
  }, [weekStart, personId])

  const days = Array.from({ length: 7 }, (_, n) => weekStart + n)
  const { rows, totals, grand } = useMemo(() => {
    const byIssue = new Map()
    const dayTotals = Array(7).fill(0)
    for (const e of entries || []) {
      const column = Math.round((Date.parse(`${e.day}T00:00:00Z`) / 86400000) - weekStart)
      if (column < 0 || column > 6) continue
      // One row per issue, or per feature for time logged straight on a feature.
      const key = e.issue_id ? `i${e.issue_id}` : `f${e.feature_id}`
      if (!byIssue.has(key)) byIssue.set(key, { ...e, key, cells: Array(7).fill(0), total: 0, notes: [] })
      const row = byIssue.get(key)
      row.cells[column] += e.hours
      row.total += e.hours
      if (e.note) row.notes.push(e.note)
      dayTotals[column] += e.hours
    }
    return {
      rows: [...byIssue.values()].sort((a, b) => a.project_name.localeCompare(b.project_name) || (a.issue_key || `~${a.feature_title}`).localeCompare(b.issue_key || `~${b.feature_title}`)),
      totals: dayTotals,
      grand: dayTotals.reduce((a, b) => a + b, 0),
    }
  }, [entries, weekStart])

  const person = people.find((p) => p.id === Number(personId))
  const exportCsv = () =>
    downloadCsv(
      `timesheet-${dayToISO(weekStart)}.csv`,
      [
        { label: 'Date', value: (e) => e.day },
        { label: 'Person', value: (e) => e.user?.full_name },
        { label: 'Project', value: (e) => e.project_name },
        { label: 'Issue', value: (e) => e.issue_key || 'Feature' },
        { label: 'Title', value: (e) => e.issue_title || e.feature_title },
        { label: 'Hours', value: (e) => e.hours },
        { label: 'Note', value: (e) => e.note },
      ],
      entries || [],
    )

  if (error && !entries) return <div className="page"><div className="form-error">{error}</div></div>
  if (!entries) return <PageSkeleton variant="list" />

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Timesheet</h1>
          <p>Time logged on issues{person ? ` by ${person.full_name}` : ''}, week by week.</p>
        </div>
        <button className="btn" onClick={exportCsv} disabled={!entries.length}><Download size={15} /> Export CSV</button>
      </div>

      <div className="toolbar">
        <button className="btn btn-icon" onClick={() => setWeekStart((w) => w - 7)} aria-label="Previous week"><ChevronLeft size={16} /></button>
        <button className="btn btn-icon" onClick={() => setWeekStart((w) => w + 7)} aria-label="Next week"><ChevronRight size={16} /></button>
        <h2 style={{ minWidth: 190 }}>{formatDate(dayToISO(weekStart))} – {formatDate(dayToISO(weekStart + 6), true)}</h2>
        <button className="btn btn-sm" onClick={() => setWeekStart(mondayOf(today))}>This week</button>
        <span className="grow" />
        <span className="muted">Total <b style={{ color: 'var(--text)' }}>{hours(grand) || '0h'}</b></span>
        {isAdmin && (
          <select className="select" value={personId} onChange={(e) => setPersonId(e.target.value)} aria-label="Person">
            <option value="">My time</option>
            {people.filter((p) => p.id !== user.id).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <Empty icon={Clock} title="No time logged this week">
            Open an issue and use “Log time” to record the hours you spend. They add up here.
          </Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="sheet">
            <thead>
              <tr>
                <th>Issue</th>
                {days.map((day, n) => (
                  <th key={day} className={`${n > 4 ? 'weekend' : ''} ${day === today ? 'today' : ''}`}>{WEEKDAYS[n]}<br />{dayToDate(day).getUTCDate()}</th>
                ))}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    {row.issue_id ? (
                      <a href="#" onClick={(e) => { e.preventDefault(); openIssue(row.issue_id) }} style={{ color: 'inherit', fontWeight: 600 }}>
                        <span className="issue-key">{row.issue_key}</span> {row.issue_title}
                      </a>
                    ) : (
                      <span style={{ fontWeight: 600 }}><span className="issue-key">Feature</span> {row.feature_title}</span>
                    )}
                    <div className="faint small row" style={{ gap: 6 }}>
                      <span className="nav-dot" style={{ background: row.project_color, margin: 0 }} />{row.project_name}
                    </div>
                  </td>
                  {row.cells.map((value, n) => (
                    <td key={n} className={`${n > 4 ? 'weekend' : ''} ${value ? 'has' : 'zero'}`}>{hours(value) || '·'}</td>
                  ))}
                  <td className="has">{hours(row.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Daily total</td>
                {totals.map((value, n) => <td key={n} className={value ? '' : 'zero'}>{hours(value) || '·'}</td>)}
                <td>{hours(grand)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
