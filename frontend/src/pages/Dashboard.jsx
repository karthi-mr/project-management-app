import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlarmClock,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  CheckCircle2,
  CircleDot,
  EyeOff,
  FolderKanban,
  Inbox,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  UserCheck,
} from 'lucide-react'
import { api, onChanged } from '../api'
import { useAuth, useToast } from '../context'
import DeadlineList from '../components/Deadlines'
import Onboarding from '../components/Onboarding'
import {
  Avatar,
  Empty,
  PRIORITIES,
  PageSkeleton,
  PriorityIcon,
  Progress,
  ProjectIcon,
  StatusBadge,
  TypeIcon,
  byKey,
  formatDate,
  isOverdue,
  timeAgo,
  useOpenIssue,
} from '../ui'

/* ───────────── Charts ───────────── */

function Donut({ segments, total, label }) {
  const radius = 52
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return (
    <svg viewBox="0 0 132 132" className="donut" role="img" aria-label={`${label}: ${total}`}>
      <circle cx="66" cy="66" r={radius} fill="none" strokeWidth="16" className="ring-bg" />
      {total > 0 && segments.filter((s) => s.count > 0).map((s) => {
        const length = (s.count / total) * circumference
        const circle = (
          <circle
            key={s.key}
            cx="66" cy="66" r={radius} fill="none" stroke={s.color} strokeWidth="16"
            strokeDasharray={`${Math.max(length - 2, 0.5)} ${circumference}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 66 66)"
          >
            <title>{`${s.label}: ${s.count}`}</title>
          </circle>
        )
        offset += length
        return circle
      })}
      <text x="66" y="64" textAnchor="middle" fontSize="24" fontWeight="700">{total}</text>
      <text x="66" y="82" textAnchor="middle" fontSize="10.5" opacity="0.6">{label}</text>
    </svg>
  )
}

function AreaChart({ points }) {
  const width = 420
  const height = 170
  const pad = { l: 26, r: 8, t: 10, b: 22 }
  const max = Math.max(1, ...points.flatMap((p) => [p.created, p.completed]))
  const x = (n) => pad.l + (n / Math.max(1, points.length - 1)) * (width - pad.l - pad.r)
  const y = (v) => pad.t + (1 - v / max) * (height - pad.t - pad.b)
  const line = (field) => points.map((p, n) => `${n ? 'L' : 'M'}${x(n).toFixed(1)},${y(p[field]).toFixed(1)}`).join(' ')
  const area = (field) => `${line(field)} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`
  const series = [
    { field: 'created', color: '#6366f1', label: 'Created' },
    { field: 'completed', color: '#22c55e', label: 'Completed' },
  ]
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="area-chart" role="img" aria-label="Issues created and completed over the last 14 days">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={pad.l} x2={width - pad.r} y1={y(max * f)} y2={y(max * f)} className="grid" />
          <text x={pad.l - 6} y={y(max * f) + 3} textAnchor="end">{Math.round(max * f)}</text>
        </g>
      ))}
      {points.map((p, n) => (n % 2 === 1 ? <text key={p.date} x={x(n)} y={height - 5} textAnchor="middle">{new Date(`${p.date}T00:00:00`).getDate()}</text> : null))}
      {series.map((s) => (
        <g key={s.field}>
          <path d={area(s.field)} fill={s.color} opacity="0.13" />
          <path d={line(s.field)} fill="none" stroke={s.color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
          {points.map((p, n) => (
            <circle key={n} cx={x(n)} cy={y(p[s.field])} r={p[s.field] ? 2.6 : 0} fill={s.color}>
              <title>{`${formatDate(p.date)} — ${p[s.field]} ${s.label.toLowerCase()}`}</title>
            </circle>
          ))}
        </g>
      ))}
    </svg>
  )
}

function Stat({ icon: Icon, label, value, color }) {
  return (
    <div className="card stat">
      <div className="stat-top">
        {label}
        <span className="stat-icon" style={{ '--c': color }}><Icon size={17} /></span>
      </div>
      <div className="stat-value">{value}</div>
    </div>
  )
}

/* ───────────── Widgets ───────────── */

const WIDGETS = [
  { key: 'stats', title: 'Key numbers', size: 'full' },
  { key: 'status', title: 'Issues by status', size: 'third' },
  { key: 'trend', title: 'Last 14 days', size: 'third' },
  { key: 'priority', title: 'Open by priority', size: 'third' },
  { key: 'my_issues', title: 'My open issues', size: 'half' },
  { key: 'deadlines', title: 'Upcoming deadlines', size: 'half' },
  { key: 'projects', title: 'Project progress', size: 'half' },
  { key: 'activity', title: 'Recent activity', size: 'half' },
]
const DEFAULT_ORDER = WIDGETS.map((w) => w.key)

function layoutFrom(preferences) {
  const saved = preferences?.dashboard || {}
  const known = new Set(DEFAULT_ORDER)
  const order = [...new Set((saved.order || []).filter((k) => known.has(k)))]
  DEFAULT_ORDER.forEach((k) => !order.includes(k) && order.push(k)) // widgets added in later versions
  return { order, hidden: (saved.hidden || []).filter((k) => known.has(k)) }
}

function greeting() {
  const hour = new Date().getHours()
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}

export default function Dashboard() {
  const { user, setUser } = useAuth()
  const toast = useToast()
  const openIssue = useOpenIssue()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [layout, setLayout] = useState(() => layoutFrom(user.preferences))

  useEffect(() => {
    const load = () => api('/dashboard').then(setData).catch((e) => setError(e.message))
    load()
    return onChanged(load)
  }, [])

  const save = async (next) => {
    setLayout(next)
    try {
      setUser(await api('/auth/preferences', { method: 'PUT', body: { preferences: { ...(user.preferences || {}), dashboard: next } } }))
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const visible = layout.order.filter((k) => !layout.hidden.includes(k))
  const move = (key, delta) => {
    const shown = [...visible]
    const from = shown.indexOf(key)
    const to = from + delta
    if (to < 0 || to >= shown.length) return
    ;[shown[from], shown[to]] = [shown[to], shown[from]]
    // Hidden widgets keep their place at the end of the saved order.
    save({ ...layout, order: [...shown, ...layout.order.filter((k) => layout.hidden.includes(k))] })
  }
  const hide = (key) => save({ ...layout, hidden: [...layout.hidden, key] })
  const show = (key) => save({ order: [...layout.order.filter((k) => k !== key), key], hidden: layout.hidden.filter((k) => k !== key) })

  if (error) return <div className="page"><div className="form-error">{error}</div></div>
  if (!data) return <PageSkeleton variant="dashboard" />

  const { stats } = data
  const totalIssues = data.by_status.reduce((sum, s) => sum + s.count, 0)
  const maxPriority = Math.max(1, ...data.by_priority.map((p) => p.count))

  const render = {
    stats: () => (
      <div className="grid grid-stats">
        <Stat icon={FolderKanban} label="Active projects" value={stats.projects} color="#6366f1" />
        <Stat icon={CircleDot} label="Open issues" value={stats.open_issues} color="#3b82f6" />
        <Stat icon={UserCheck} label="Assigned to me" value={stats.my_open_issues} color="#a855f7" />
        <Stat icon={AlarmClock} label="Overdue" value={stats.overdue} color="#ef4444" />
        <Stat icon={CheckCircle2} label="Done this week" value={stats.completed_this_week} color="#22c55e" />
      </div>
    ),
    status: () => (
      <div className="card">
        <div className="card-header"><h2>Issues by status</h2></div>
        <div className="card-body donut-wrap">
          <Donut segments={data.by_status} total={totalIssues} label="issues" />
          <div className="grow" style={{ minWidth: 130 }}>
            {data.by_status.map((s) => (
              <div className="legend-item" key={s.key} style={{ marginBottom: 7 }}>
                <i style={{ background: s.color }} />{s.label}<b>{s.count}</b>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    trend: () => (
      <div className="card">
        <div className="card-header">
          <h2>Last 14 days</h2>
          <span className="row small muted" style={{ gap: 12 }}>
            <span className="legend-item"><i style={{ background: '#6366f1' }} />Created</span>
            <span className="legend-item"><i style={{ background: '#22c55e' }} />Completed</span>
          </span>
        </div>
        <div className="card-body"><AreaChart points={data.trend} /></div>
      </div>
    ),
    priority: () => (
      <div className="card">
        <div className="card-header"><h2>Open by priority</h2></div>
        <div className="card-body">
          {data.by_priority.map((p) => (
            <div className="hbar" key={p.key}>
              <PriorityIcon priority={p.key} label />
              <Progress value={(p.count / maxPriority) * 100} color={byKey(PRIORITIES, p.key).color} />
              <b>{p.count}</b>
            </div>
          ))}
        </div>
      </div>
    ),
    my_issues: () => (
      <div className="card">
        <div className="card-header" style={{ paddingBottom: 12 }}>
          <h2>My open issues</h2>
          <Link to="/my-issues" className="small">View all</Link>
        </div>
        {data.my_issues.length === 0 ? (
          <Empty icon={Inbox} title="You're all caught up">Nothing is assigned to you right now.</Empty>
        ) : (
          data.my_issues.map((issue) => (
            <button className="list-row" key={issue.id} onClick={() => openIssue(issue.id)} style={{ borderTop: '1px solid var(--border)' }}>
              <TypeIcon type={issue.type} />
              <span className="issue-key">{issue.key}</span>
              <span className="truncate grow" style={{ fontWeight: 550 }}>{issue.title}</span>
              {issue.due_date && (
                <span className={`due ${isOverdue(issue.due_date) ? 'overdue' : ''}`}><CalendarDays size={12} /> {formatDate(issue.due_date)}</span>
              )}
              <PriorityIcon priority={issue.priority} />
              <span className="hide-mobile"><StatusBadge issue={issue} /></span>
            </button>
          ))
        )}
      </div>
    ),
    deadlines: () => (
      <div className="card">
        <div className="card-header">
          <h2>Upcoming deadlines</h2>
          <Link to="/calendar" className="small">Calendar</Link>
        </div>
        <div className="card-body">
          {data.deadlines.length === 0 ? <p className="muted">Nothing overdue or due in the next 14 days.</p> : <DeadlineList items={data.deadlines} />}
        </div>
      </div>
    ),
    projects: () => (
      <div className="card">
        <div className="card-header">
          <h2>Project progress</h2>
          <Link to="/roadmap" className="small">Roadmap</Link>
        </div>
        <div className="card-body stack">
          {data.projects.length === 0 && <p className="muted">No projects yet.</p>}
          {data.projects.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
              <div className="row between" style={{ marginBottom: 6 }}>
                <span className="row truncate" style={{ gap: 8 }}><ProjectIcon project={p} size={22} /><b className="truncate">{p.name}</b></span>
                <span className="small muted">{p.done_count}/{p.issue_count} · {p.progress}%</span>
              </div>
              <Progress value={p.progress} color={p.color} />
            </Link>
          ))}
        </div>
      </div>
    ),
    activity: () => (
      <div className="card">
        <div className="card-header"><h2>Recent activity</h2></div>
        <div className="card-body">
          {data.activity.length === 0 && <p className="muted">Activity from your projects will show up here.</p>}
          <div className="feed">
            {data.activity.map((a) => (
              <div className="feed-item" key={a.id}>
                <Avatar user={a.user} size={26} />
                <span className="grow">
                  <span className="who">{a.user?.full_name || 'Someone'}</span>{' '}
                  <span className="muted">{a.message}</span>{' '}
                  {a.issue_key && <a href="#" onClick={(e) => { e.preventDefault(); openIssue(a.issue_id) }} className="issue-key">{a.issue_key}</a>}
                  <div className="faint small">{a.project_name} · {timeAgo(a.created_at)}</div>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{greeting()}, {user.full_name.split(' ')[0]}</h1>
          <p>Here is what is happening across your projects.</p>
        </div>
        <div className="row">
          {editing && (
            <button className="btn btn-ghost" onClick={() => save({ order: DEFAULT_ORDER, hidden: [] })}><RotateCcw size={15} /> Reset</button>
          )}
          <button className={`btn ${editing ? 'btn-primary' : ''}`} onClick={() => setEditing((v) => !v)}>
            <SlidersHorizontal size={15} /> {editing ? 'Done' : 'Customise'}
          </button>
        </div>
      </div>
      <Onboarding />

      {editing && (
        <div className="callout" style={{ marginBottom: 18, alignItems: 'center', flexWrap: 'wrap' }}>
          <SlidersHorizontal size={16} />
          <span className="grow">Use the arrows on each card to reorder it, or the eye to hide it. Your layout is saved to your account.</span>
          {layout.hidden.map((key) => (
            <button key={key} className="btn btn-sm" onClick={() => show(key)}><Plus size={13} /> {WIDGETS.find((w) => w.key === key).title}</button>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="card"><Empty icon={SlidersHorizontal} title="Every card is hidden" action={<button className="btn btn-primary" onClick={() => save({ order: DEFAULT_ORDER, hidden: [] })}>Restore the default dashboard</button>} /></div>
      ) : (
        <div className="widgets">
          {visible.map((key, n) => {
            const widget = WIDGETS.find((w) => w.key === key)
            return (
              <div key={key} className={`widget w-${widget.size} ${editing ? 'editing' : ''}`}>
                {editing && (
                  <div className="widget-tools">
                    <button onClick={() => move(key, -1)} disabled={n === 0} aria-label={`Move ${widget.title} earlier`} title="Move earlier"><ArrowUp size={14} /></button>
                    <button onClick={() => move(key, 1)} disabled={n === visible.length - 1} aria-label={`Move ${widget.title} later`} title="Move later"><ArrowDown size={14} /></button>
                    <button onClick={() => hide(key)} aria-label={`Hide ${widget.title}`} title="Hide"><EyeOff size={14} /></button>
                  </div>
                )}
                {render[key]()}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
