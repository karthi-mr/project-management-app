import { useEffect, useState } from 'react'
import { CalendarDays, Inbox } from 'lucide-react'
import { api, onChanged } from '../api'
import {
  Empty,
  PriorityIcon,
  PageSkeleton,
  STATUSES,
  Spinner,
  TypeIcon,
  formatDate,
  isOverdue,
  useOpenIssue,
} from '../ui'

export default function MyIssues() {
  const openIssue = useOpenIssue()
  const [issues, setIssues] = useState(null)
  const [error, setError] = useState('')
  const [showDone, setShowDone] = useState(false)

  useEffect(() => {
    const load = () => api('/issues?mine=true&limit=1000').then(setIssues).catch((e) => setError(e.message))
    load()
    return onChanged(load)
  }, [])

  if (error) return <div className="page"><div className="form-error">{error}</div></div>
  if (!issues) return <PageSkeleton variant="list" />

  const open = issues.filter((i) => i.status !== 'done')
  const overdue = open.filter((i) => isOverdue(i.due_date)).length
  // Projects can have their own workflows, so group by the status name; finished work is last.
  const groupMap = new Map()
  for (const issue of issues) {
    if (!showDone && issue.status === 'done') continue
    const name = issue.status === 'done' ? 'done' : (issue.status_label || issue.status).toLowerCase()
    if (!groupMap.has(name)) groupMap.set(name, { key: name, label: issue.status === 'done' ? 'Done' : issue.status_label, color: issue.status_color, items: [], done: issue.status === 'done' })
    groupMap.get(name).items.push(issue)
  }
  const order = STATUSES.map((st) => st.label.toLowerCase())
  const groups = [...groupMap.values()]
    .map((g) => ({ ...g, items: g.items.sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999')) }))
    .sort((a, b) => (a.done - b.done) || ((order.indexOf(a.key) + 1 || 50) - (order.indexOf(b.key) + 1 || 50)))

  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="page-header">
        <div>
          <h1>My issues</h1>
          <p>
            {open.length} open{overdue > 0 && <> · <span className="danger-text">{overdue} overdue</span></>}
          </p>
        </div>
        <label className="check-item">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          Show completed
        </label>
      </div>

      {groups.length === 0 ? (
        <div className="card">
          <Empty icon={Inbox} title="Nothing assigned to you">Issues assigned to you across all projects appear here.</Empty>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {groups.map((g) => (
            <div key={g.key}>
              <div className="group-title">
                <i style={{ width: 8, height: 8, borderRadius: '50%', background: g.color }} />
                {g.label} <span className="faint">{g.items.length}</span>
              </div>
              {g.items.map((issue) => (
                <button className="list-row" key={issue.id} onClick={() => openIssue(issue.id)} style={{ borderTop: '1px solid var(--border)' }}>
                  <TypeIcon type={issue.type} />
                  <span className="issue-key">{issue.key}</span>
                  <span className="grow truncate">
                    <span style={{ fontWeight: 550 }}>{issue.title}</span>
                  </span>
                  <span className="row faint small hide-mobile" style={{ gap: 6 }}>
                    <span className="nav-dot" style={{ background: issue.project_color, margin: 0 }} />
                    {issue.project_name}
                  </span>
                  {issue.due_date && (
                    <span className={`due ${isOverdue(issue.due_date, issue.status === 'done') ? 'overdue' : ''}`}>
                      <CalendarDays size={12} /> {formatDate(issue.due_date)}
                    </span>
                  )}
                  <PriorityIcon priority={issue.priority} />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
