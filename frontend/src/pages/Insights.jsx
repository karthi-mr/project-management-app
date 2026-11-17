import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Download, Gauge, Pencil, Printer, RotateCcw, Trash2, Wallet, Layers } from 'lucide-react'
import { api, notifyChanged, onChanged } from '../api'
import { useAuth, useConfirm, useToast } from '../context'
import { UpgradeNotice, useFeature } from '../components/License'
import {
  Avatar,
  Badge,
  Empty,
  Field,
  PHASES,
  PageSkeleton,
  Progress,
  ProjectIcon,
  ProjectStatusBadge,
  Spinner,
  byKey,
  dayToISO,
  downloadCsv,
  formatDate,
  parseDay,
  timeAgo,
  todayDay,
  useOpenIssue,
} from '../ui'

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'SGD', 'AED', 'JPY', 'CNY', 'CHF', 'ZAR']

export function money(value, currency = 'USD') {
  if (value == null) return '—'
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: value >= 1000 ? 0 : 2 }).format(value)
  } catch {
    return `${currency} ${Math.round(value).toLocaleString()}`
  }
}

/* ═════════════ Budget card (project overview) ═════════════ */

export function BudgetCard({ project, reload }) {
  const toast = useToast()
  const [data, setData] = useState(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ budget: project.budget ?? '', currency: project.currency || 'USD' })

  const load = () => api(`/projects/${project.id}/budget`).then(setData).catch(() => setData(false))
  useEffect(() => {
    load()
    return onChanged(load)
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e) => {
    e.preventDefault()
    try {
      await api(`/projects/${project.id}`, { method: 'PATCH', body: { budget: form.budget === '' ? null : Number(form.budget), currency: form.currency } })
      setEditing(false)
      toast('Budget saved')
      reload()
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  if (data === false) return null // only owners and administrators see costs
  if (!data) return <div className="card card-pad"><Spinner /></div>
  const used = data.used_percent
  const over = data.budget != null && data.cost > data.budget
  return (
    <div className="card">
      <div className="card-header">
        <h2>Budget</h2>
        {!editing && <button className="btn btn-ghost btn-sm" onClick={() => { setForm({ budget: data.budget ?? '', currency: data.currency }); setEditing(true) }}><Pencil size={13} /> {data.budget == null ? 'Set budget' : 'Edit'}</button>}
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        {editing ? (
          <form className="form-grid" style={{ gridTemplateColumns: '1fr 110px auto', alignItems: 'end' }} onSubmit={save}>
            <Field label="Budget"><input className="input" type="number" min="0" step="any" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} placeholder="No budget" autoFocus /></Field>
            <Field label="Currency">
              <select className="select" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
            </Field>
            <span className="row" style={{ gap: 4 }}><button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button><button className="btn btn-primary">Save</button></span>
          </form>
        ) : (
          <>
            <div className="row between row-wrap" style={{ alignItems: 'baseline' }}>
              <span style={{ fontSize: 24, fontWeight: 700 }} className={over ? 'danger-text' : ''}>{money(data.cost, data.currency)}</span>
              <span className="muted">{data.budget != null ? `of ${money(data.budget, data.currency)} · ${used}% used` : 'spent, no budget set'}</span>
            </div>
            {data.budget != null && <Progress value={Math.min(100, used || 0)} color={over ? '#ef4444' : used > 85 ? '#f59e0b' : '#22c55e'} />}
            <div className="small muted">
              {data.hours}h logged{data.remaining != null && ` · ${over ? 'over by' : 'remaining'} ${money(Math.abs(data.remaining), data.currency)}`}
              {data.unpriced_hours > 0 && <> · <span className="danger-text">{data.unpriced_hours}h have no hourly rate</span> (set rates under Users)</>}
            </div>
            {data.features?.length > 0 && (
              <div>
                <div className="section-title" style={{ marginBottom: 4 }}>By feature</div>
                {data.features.map((f) => (
                  <div className="time-row" key={f.feature?.id ?? 'none'}>
                    <Layers size={15} className="faint" />
                    <span className="grow truncate">{f.feature ? f.feature.title : <span className="muted">Not linked to a feature</span>}</span>
                    <span className="muted small" title="Logged on the feature itself, out of the total">{f.direct_hours > 0 ? `${f.direct_hours}h direct · ` : ''}{f.hours}h</span>
                    <b style={{ minWidth: 80, textAlign: 'right' }}>{money(f.cost, data.currency)}</b>
                  </div>
                ))}
              </div>
            )}
            {data.people.length > 0 && (
              <div>
                <div className="section-title" style={{ marginBottom: 4 }}>By person</div>
                {data.people.map((p) => (
                  <div className="time-row" key={p.user?.id ?? 'none'}>
                    <Avatar user={p.user} size={20} />
                    <span className="grow truncate">{p.user?.full_name || 'Deleted user'}</span>
                    <span className="muted">{p.hours}h</span>
                    <b style={{ minWidth: 80, textAlign: 'right' }}>{p.unpriced_hours === p.hours ? '—' : money(p.cost, data.currency)}</b>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* ═════════════ Workload ═════════════ */

function loadColor(ratio) {
  if (ratio === 0) return 'transparent'
  if (ratio > 1) return 'color-mix(in srgb, #ef4444 32%, transparent)'
  if (ratio > 0.8) return 'color-mix(in srgb, #f59e0b 30%, transparent)'
  return `color-mix(in srgb, #22c55e ${Math.round(10 + ratio * 22)}%, transparent)`
}

export function Workload() {
  const openIssue = useOpenIssue()
  const today = todayDay()
  const monday = today - ((new Date(today * 86400000).getUTCDay() + 6) % 7)
  const [start, setStart] = useState(monday)
  const [projectId, setProjectId] = useState('')
  const [projects, setProjects] = useState([])
  const [data, setData] = useState(null)
  const [openRow, setOpenRow] = useState(null)
  const allowed = useFeature('workload')

  useEffect(() => {
    api('/projects').then((rows) => setProjects(rows.filter((p) => p.status !== 'archived'))).catch(() => {})
  }, [])
  useEffect(() => {
    if (!allowed) return undefined
    const load = () => api(`/workload?start=${dayToISO(start)}&weeks=6${projectId ? `&project_id=${projectId}` : ''}`).then(setData).catch(() => {})
    load()
    return onChanged(load)
  }, [start, projectId, allowed])

  if (!allowed) {
    return (
      <div className="page">
        <div className="page-header"><div><h1>Workload</h1><p>See who has too much or too little planned.</p></div></div>
        <UpgradeNotice feature="workload" />
      </div>
    )
  }
  if (!data) return <PageSkeleton variant="list" />
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Workload</h1>
          <p>Planned hours per person per week against their capacity, so you can spot overload before assigning more.</p>
        </div>
      </div>
      <div className="toolbar">
        <button className="btn btn-icon" onClick={() => setStart((s) => s - 7)} aria-label="Earlier"><ChevronLeft size={16} /></button>
        <button className="btn btn-icon" onClick={() => setStart((s) => s + 7)} aria-label="Later"><ChevronRight size={16} /></button>
        <button className="btn btn-sm" onClick={() => setStart(monday)}>This week</button>
        <span className="grow" />
        <span className="gantt-legend hide-mobile">
          <span><i style={{ background: '#22c55e' }} />Under 80%</span>
          <span><i style={{ background: '#f59e0b' }} />80–100%</span>
          <span><i style={{ background: '#ef4444' }} />Over capacity</span>
        </span>
        <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      {data.people.length === 0 ? (
        <div className="card"><Empty icon={Gauge} title="Nobody to show">People appear here once they are members of a project you can see.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table className="sheet workload">
            <thead>
              <tr>
                <th>Person</th>
                {data.weeks.map((w) => <th key={w} className={parseDay(w) === monday ? 'today' : ''}>Week of<br />{formatDate(w)}</th>)}
                <th>Unscheduled</th>
              </tr>
            </thead>
            <tbody>
              {data.people.map((row) => (
                <Fragment key={row.user.id}>
                  <tr>
                    <td>
                      <button className="row feature-title" style={{ gap: 8 }} onClick={() => setOpenRow(openRow === row.user.id ? null : row.user.id)} aria-expanded={openRow === row.user.id}>
                        <Avatar user={row.user} size={26} />
                        <span style={{ textAlign: 'left' }}>
                          {row.user.full_name}
                          <div className="faint small" style={{ fontWeight: 400 }}>{row.capacity}h/week · {row.open_issues} open{row.overdue_hours > 0 && <span className="danger-text"> · {row.overdue_hours}h overdue</span>}</div>
                        </span>
                      </button>
                    </td>
                    {row.planned.map((hours, n) => {
                      const ratio = row.capacity ? hours / row.capacity : 0
                      return (
                        <td key={n} style={{ background: loadColor(ratio) }} title={`${hours}h planned, ${row.logged[n]}h logged, ${row.capacity}h capacity`}>
                          <b>{hours ? `${hours}h` : '·'}</b>
                          {row.logged[n] > 0 && <div className="faint small">{row.logged[n]}h logged</div>}
                        </td>
                      )
                    })}
                    <td className={row.unscheduled_hours ? '' : 'zero'}>{row.unscheduled_hours ? `${row.unscheduled_hours}h` : '·'}</td>
                  </tr>
                  {openRow === row.user.id && (
                    <tr>
                      <td colSpan={data.weeks.length + 2} style={{ textAlign: 'left', background: 'var(--surface-2)' }}>
                        {row.issues.length === 0 ? <span className="muted small">No open issues.</span> : row.issues.map((i) => (
                          <div className="time-row" key={i.id}>
                            <span className="nav-dot" style={{ background: i.project_color, margin: 0 }} />
                            <a href="#" className="issue-key" onClick={(e) => { e.preventDefault(); openIssue(i.id) }}>{i.key}</a>
                            <span className="grow truncate">{i.title}</span>
                            <span className="muted">{i.remaining ? `${i.remaining}h left` : 'no estimate'}</span>
                            <span className={`due ${i.due_date && parseDay(i.due_date) < today ? 'overdue' : ''}`}>{i.due_date ? formatDate(i.due_date) : 'no due date'}</span>
                          </div>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted" style={{ marginTop: 12 }}>
        Planned hours are each open issue's remaining estimate (estimate minus time logged), spread over the working days up to its due date; overdue work counts in the current week.
        Issues without a due date are “unscheduled”. Administrators set each person's weekly capacity and hourly rate under Users.
      </p>
    </div>
  )
}

/* ═════════════ Portfolio ═════════════ */

const HEALTH = {
  done: { label: 'Completed', color: '#3b82f6' },
  overdue: { label: 'Overdue', color: '#ef4444' },
  risk: { label: 'At risk', color: '#f59e0b' },
  track: { label: 'On track', color: '#22c55e' },
  unplanned: { label: 'No deadline', color: '#94a3b8' },
}

export function Portfolio() {
  const navigate = useNavigate()
  const [rows, setRows] = useState(null)
  const [health, setHealth] = useState('')

  useEffect(() => {
    const load = () => api('/portfolio').then(setRows).catch(() => setRows([]))
    load()
    return onChanged(load)
  }, [])

  const shown = useMemo(() => (rows || []).filter((r) => !health || r.health === health), [rows, health])
  if (!rows) return <PageSkeleton variant="list" />

  const counts = Object.fromEntries(Object.keys(HEALTH).map((k) => [k, rows.filter((r) => r.health === k).length]))
  const exportCsv = () =>
    downloadCsv(`portfolio-${dayToISO(todayDay())}.csv`, [
      { label: 'Project', value: (r) => r.name },
      { label: 'Key', value: (r) => r.key },
      { label: 'Owner', value: (r) => r.owner?.full_name },
      { label: 'Health', value: (r) => HEALTH[r.health].label },
      { label: 'Status', value: (r) => r.status },
      { label: 'Phase', value: (r) => byKey(PHASES, r.phase).label },
      { label: 'Progress %', value: (r) => r.progress },
      { label: 'Open issues', value: (r) => r.open_issues },
      { label: 'Overdue issues', value: (r) => r.overdue_issues },
      { label: 'High risks', value: (r) => r.high_risks },
      { label: 'Features released', value: (r) => (r.features_total == null ? '' : `${r.features_released}/${r.features_total}`) },
      { label: 'Next milestone', value: (r) => (r.next_milestone ? `${r.next_milestone.name} (${r.next_milestone.due_date})` : '') },
      { label: 'Due date', value: (r) => r.due_date },
      { label: 'Estimated hours', value: (r) => r.estimate_hours },
      { label: 'Logged hours', value: (r) => r.spent_hours },
      { label: 'Currency', value: (r) => (r.can_see_cost ? r.currency : '') },
      { label: 'Budget', value: (r) => (r.can_see_cost ? r.budget ?? '' : '') },
      { label: 'Cost', value: (r) => (r.can_see_cost ? r.cost : '') },
    ], shown)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Portfolio</h1>
          <p>Every project on one page: health, progress, risk and budget. Generated {formatDate(dayToISO(todayDay()), true)}.</p>
        </div>
        <div className="row no-print">
          <button className="btn" onClick={exportCsv} disabled={!shown.length}><Download size={15} /> CSV</button>
          <button className="btn btn-primary" onClick={() => window.print()}><Printer size={15} /> Print / Save as PDF</button>
        </div>
      </div>

      <div className="pipeline no-print" style={{ marginBottom: 14 }}>
        <button className={`pipe ${health === '' ? 'active' : ''}`} style={{ '--c': 'var(--accent)' }} onClick={() => setHealth('')}>All <b>{rows.length}</b></button>
        {Object.entries(HEALTH).map(([key, meta]) => counts[key] > 0 && (
          <button key={key} className={`pipe ${health === key ? 'active' : ''}`} style={{ '--c': meta.color }} onClick={() => setHealth(health === key ? '' : key)}>
            <i /> {meta.label} <b>{counts[key]}</b>
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="card"><Empty icon={Wallet} title="No projects yet" /></div>
      ) : (
        <div className="card table-wrap">
          <table className="table portfolio">
            <thead>
              <tr><th>Project</th><th>Health</th><th>Phase</th><th style={{ width: 150 }}>Progress</th><th>Issues</th><th>Risks</th><th>Next milestone</th><th>Due</th><th>Budget</th></tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const used = r.budget ? Math.round((r.cost / r.budget) * 100) : null
                return (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/projects/${r.id}`)}>
                    <td>
                      <span className="row" style={{ gap: 10 }}>
                        <ProjectIcon project={r} size={30} />
                        <span style={{ minWidth: 0 }}>
                          <b className="truncate" style={{ display: 'block', maxWidth: 220 }}>{r.name}</b>
                          <span className="faint small">{r.owner?.full_name || 'No owner'} · <ProjectStatusBadge status={r.status} /></span>
                        </span>
                      </span>
                    </td>
                    <td><Badge color={HEALTH[r.health].color}>{HEALTH[r.health].label}</Badge></td>
                    <td className="small">{byKey(PHASES, r.phase).label}</td>
                    <td>
                      <div className="row between small" style={{ marginBottom: 4 }}><span className="muted">{r.issue_count - r.open_issues}/{r.issue_count}</span><b>{r.progress}%</b></div>
                      <Progress value={r.progress} color={r.color} />
                    </td>
                    <td className="small">{r.open_issues} open{r.overdue_issues > 0 && <div className="danger-text">{r.overdue_issues} overdue</div>}</td>
                    <td className="small">{r.open_risks}{r.high_risks > 0 && <div className="danger-text">{r.high_risks} high</div>}</td>
                    <td className="small">{r.next_milestone ? <>{r.next_milestone.name}<div className="faint">{formatDate(r.next_milestone.due_date)}</div></> : <span className="faint">—</span>}</td>
                    <td className="small">{r.due_date ? <span className={parseDay(r.due_date) < todayDay() && r.health !== 'done' ? 'danger-text' : ''}>{formatDate(r.due_date)}</span> : <span className="faint">—</span>}</td>
                    <td className="small">
                      {!r.can_see_cost ? <span className="faint">—</span> : (
                        <>
                          <b className={used > 100 ? 'danger-text' : ''}>{money(r.cost, r.currency)}</b>
                          <div className="faint">{r.budget != null ? `of ${money(r.budget, r.currency)} (${used}%)` : 'no budget'}</div>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted" style={{ marginTop: 12 }}>Budget figures appear only for projects you own (administrators see all). Cost is logged hours × each person's hourly rate when the time was logged.</p>
    </div>
  )
}

/* ═════════════ Recycle bin ═════════════ */

const KIND_LABEL = { project: 'Project', milestone: 'Milestone', issue: 'Issue', release: 'Release', feature: 'Feature', document: 'Document', risk: 'Risk' }

export function RecycleBin() {
  const { user } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const [data, setData] = useState(null)
  const [kind, setKind] = useState('')

  const load = () => api('/trash').then(setData).catch((err) => toast(err.message, 'error'))
  useEffect(() => {
    load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const restore = async (item) => {
    try {
      const result = await api(`/trash/${item.kind}/${item.id}/restore`, { method: 'POST' })
      toast(`${KIND_LABEL[item.kind]} restored`, 'success', item.kind === 'project'
        ? { action: { label: 'Open', onClick: () => (window.location.href = `/projects/${result.project_id}`) } }
        : {})
      load()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const purge = async (item) => {
    const ok = await confirm({ title: `Delete “${item.title}” permanently?`, message: 'This cannot be undone.', confirmLabel: 'Delete forever', danger: true })
    if (!ok) return
    try {
      await api(`/trash/${item.kind}/${item.id}`, { method: 'DELETE' })
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const empty = async () => {
    const ok = await confirm({ title: 'Empty the recycle bin?', message: `All ${data.items.length} item(s) are deleted permanently. This cannot be undone.`, confirmLabel: 'Empty recycle bin', danger: true })
    if (!ok) return
    try {
      await api('/trash', { method: 'DELETE' })
      toast('Recycle bin emptied')
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  if (!data) return <PageSkeleton variant="list" />
  const items = data.items.filter((i) => !kind || i.kind === kind)
  const kinds = [...new Set(data.items.map((i) => i.kind))]

  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="page-header">
        <div>
          <h1>Recycle bin</h1>
          <p>Deleted items stay here for {data.retention_days} days before they are removed for good.</p>
        </div>
        {user.role === 'admin' && data.items.length > 0 && <button className="btn btn-danger" onClick={empty}><Trash2 size={15} /> Empty recycle bin</button>}
      </div>
      {kinds.length > 1 && (
        <div className="pipeline" style={{ marginBottom: 14 }}>
          <button className={`pipe ${kind === '' ? 'active' : ''}`} style={{ '--c': 'var(--accent)' }} onClick={() => setKind('')}>All <b>{data.items.length}</b></button>
          {kinds.map((k) => <button key={k} className={`pipe ${kind === k ? 'active' : ''}`} style={{ '--c': 'var(--text-3)' }} onClick={() => setKind(k)}>{KIND_LABEL[k]} <b>{data.items.filter((i) => i.kind === k).length}</b></button>)}
        </div>
      )}
      {items.length === 0 ? (
        <div className="card"><Empty icon={Trash2} title="The recycle bin is empty">Deleted projects, issues, features, releases, milestones, documents and risks appear here.</Empty></div>
      ) : (
        <div className="card">
          {items.map((item) => {
            const daysLeft = Math.max(0, parseDay(item.expires_at.slice(0, 10)) - todayDay())
            return (
              <div className="list-row" key={`${item.kind}-${item.id}`} style={{ cursor: 'default' }}>
                <span className="tag">{KIND_LABEL[item.kind]}</span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <div className="truncate" style={{ fontWeight: 600 }}>{item.title}</div>
                  <div className="small faint truncate">
                    {item.kind !== 'project' && <>{item.project.name}{item.project.deleted && ' (deleted)'} · </>}
                    Deleted {timeAgo(item.deleted_at)}{item.deleted_by && ` by ${item.deleted_by.full_name}`} · {daysLeft === 0 ? 'removed today' : `removed in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}
                  </div>
                </span>
                <button className="btn btn-sm" onClick={() => restore(item)} disabled={item.kind !== 'project' && item.project.deleted} title={item.kind !== 'project' && item.project.deleted ? 'Restore the project first' : undefined}><RotateCcw size={13} /> Restore</button>
                {item.can_purge && <button className="btn btn-ghost btn-sm btn-icon danger-text" onClick={() => purge(item)} aria-label="Delete permanently" title="Delete permanently"><Trash2 size={14} /></button>}
              </div>
            )
          })}
        </div>
      )}
      <p className="small muted" style={{ marginTop: 12 }}>You see items from projects you own and anything you deleted yourself. Administrators see everything. <Link to="/projects">Back to projects</Link></p>
    </div>
  )
}
