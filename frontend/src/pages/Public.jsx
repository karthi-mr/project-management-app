import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  Activity, ArrowRight, BarChart3, MessageSquare, ThumbsUp, CalendarDays, Check, CheckSquare, Flag, GanttChart, Layers, MessagesSquare, Rocket, ShieldCheck, Users,
} from 'lucide-react'
import { api } from '../api'
import { Field, timeAgo, formatDateTime } from '../ui'
import { Badge, FEATURE_STAGES, MILESTONE_STAGES, PRIORITIES, Progress, RELEASE_STATUSES, Spinner, byKey, formatDate } from '../ui'
import { LANGUAGES, getLanguage, setLocale, useT } from '../i18n'
import { PlanFeatures, money } from '../components/License'
import ThemeToggle from '../components/ThemeToggle'

function Brand({ name = 'Trackly', logo }) {
  return (
    <span className="brand" style={{ padding: 0 }}>
      {logo ? <img src={logo} alt="" className="brand-logo" /> : <span className="brand-mark"><Check size={18} strokeWidth={3} /></span>}
      {name}
    </span>
  )
}

export function LanguagePicker() {
  useT()
  return (
    <select className="select lang-select" value={getLanguage()} onChange={(e) => setLocale({ language: e.target.value })} aria-label="Language">
      {LANGUAGES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
    </select>
  )
}

function PublicShell({ children, company }) {
  const t = useT()
  return (
    <div className="public">
      <header className="public-nav">
        <Link to="/welcome"><Brand name={company || 'Trackly'} /></Link>
        <span className="grow" />
        <a className="hide-mobile" href="/welcome#features">{t('land.features')}</a>
        <a className="hide-mobile" href="/welcome#pricing">{t('land.pricing')}</a>
        <span className="hide-mobile"><LanguagePicker /></span>
        <span className="hide-mobile"><ThemeToggle /></span>
        <Link className="btn btn-sm" to="/login">{t('land.signIn')}</Link>
      </header>
      {children}
      <footer className="public-foot">
        <span>© {new Date().getFullYear()} {company || 'Trackly'}</span>
        <Link to="/terms">Terms</Link>
        <Link to="/privacy">Privacy</Link>
        <Link to="/status">Status</Link>
        <span className="show-mobile-inline"><LanguagePicker /></span>
      </footer>
    </div>
  )
}

const HIGHLIGHTS = [
  { icon: Layers, title: 'Features and issues', text: 'Plan what you deliver as features, and track the daily work under them on boards and lists.' },
  { icon: ShieldCheck, title: 'Signed-off stages', text: 'Every feature and milestone moves stage by stage, each one approved by the owner or a manager.' },
  { icon: GanttChart, title: 'Timeline and roadmap', text: 'Gantt charts, milestones, sprints and a roadmap across all your projects.' },
  { icon: Rocket, title: 'Releases', text: 'Group features into releases and follow them from planning to production.' },
  { icon: Users, title: 'Roles and client access', text: 'Decide what each person sees, and share a read-only progress page with clients.' },
  { icon: MessagesSquare, title: 'Chat built in', text: 'Message teammates directly or in groups without leaving your work.' },
  { icon: BarChart3, title: 'Reports and budgets', text: 'Workload, time tracking, cost against budget and exportable reports.' },
  { icon: CheckSquare, title: 'Your data stays yours', text: 'Each company has a private workspace. Export everything or delete it whenever you want.' },
]

export function Landing() {
  const t = useT()
  const [data, setData] = useState(null)
  useEffect(() => { api('/public/plans').then(setData).catch(() => setData({ plans: [], settings: { company_name: 'Trackly', currency: 'USD', trial_days: 14, allow_signup: true, tagline: '' } })) }, [])
  const s = data?.settings
  return (
    <PublicShell company={s?.company_name}>
      <section className="hero">
        <h1>{s?.tagline || 'Plan, track and deliver every project in one place.'}</h1>
        <p>
          Features, issues, milestones, releases and chat for your whole team, with sign-offs at every stage so nothing
          moves forward unapproved.
        </p>
        <div className="row" style={{ justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
          {(!s || s.allow_signup) && <Link className="btn btn-primary btn-lg" to="/signup">{t('land.start')} <ArrowRight size={16} /></Link>}
          <Link className="btn btn-lg" to="/login">{t('land.signIn')}</Link>
        </div>
        {s && <div className="small muted">{s.allow_signup ? `${s.trial_days} days free. ${t('land.noCard')}` : 'Contact us to get a workspace.'}</div>}
      </section>

      <section className="public-section" id="features">
        <h2>{t('land.everything')}</h2>
        <div className="highlight-grid">
          {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
            <div className="card highlight" key={title}>
              <span className="stat-icon" style={{ '--c': 'var(--accent)' }}><Icon size={17} /></span>
              <h3>{title}</h3>
              <p className="muted small">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="public-section" id="pricing">
        <h2>{t('land.plansTitle')}</h2>
        {!data ? <Spinner /> : (
          <div className="plan-grid">
            {data.plans.map((plan) => (
              <div className="card plan-card" key={plan.id}>
                <h3>{plan.name}</h3>
                <p className="muted small" style={{ minHeight: 34 }}>{plan.description}</p>
                <div className="plan-price">{money(plan.price_monthly, s.currency)} <span>{t('land.perUserMonth')}</span></div>
                <div className="small muted">or {money(plan.price_yearly, s.currency)} per user / year</div>
                {s.allow_signup && <Link className="btn btn-primary btn-block" to="/signup">{t('land.start')}</Link>}
                <PlanFeatures plan={plan} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="hero" style={{ paddingTop: 30 }}>
        <h2>{t('land.ready')}</h2>
        {(!s || s.allow_signup) && <div><Link className="btn btn-primary btn-lg" to="/signup">{t('land.start')} <ArrowRight size={16} /></Link></div>}
        {s?.support_email && <div className="small muted">Questions? Write to {s.support_email}</div>}
      </section>
    </PublicShell>
  )
}

export function Legal({ kind }) {
  const [data, setData] = useState(null)
  useEffect(() => { api('/public/legal').then(setData).catch(() => setData({ terms: '', privacy: '' })) }, [])
  return (
    <PublicShell company={data?.company_name}>
      <section className="public-section legal">
        <h1>{kind === 'terms' ? 'Terms of service' : 'Privacy policy'}</h1>
        {!data ? <Spinner /> : <div className="legal-text">{data[kind] || 'Not published yet.'}</div>}
        {data?.support_email && <p className="muted small">Questions about this page: {data.support_email}</p>}
      </section>
    </PublicShell>
  )
}

/* ───────────── What a client sees through a share link ───────────── */

export function SharedProject() {
  const { token } = useParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api(`/public/share/${token}`).then(setData).catch((e) => setError(e.message))
  }, [token])

  useEffect(() => {
    if (data?.workspace.brand_color) document.documentElement.style.setProperty('--accent', data.workspace.brand_color)
  }, [data])

  if (error) {
    return (
      <div className="auth-page"><div className="auth-card"><Brand /><div><h1>Link not available</h1><p className="muted">{error}. Ask the person who sent it for a new one.</p></div></div></div>
    )
  }
  if (!data) return <Spinner page />
  const { project, workspace } = data
  return (
    <div className="public">
      <header className="public-nav">
        <Brand name={workspace.name} logo={workspace.logo_url} />
        <span className="grow" />
        <ThemeToggle />
      </header>
      <section className="public-section share">
        <div className="row row-wrap" style={{ gap: 14, alignItems: 'center' }}>
          {project.logo_url ? <img src={project.logo_url} alt="" className="brand-logo lg" /> : <span className="project-icon" style={{ background: project.color, width: 46, height: 46 }}>{project.name.slice(0, 2).toUpperCase()}</span>}
          <div className="grow">
            <h1 style={{ fontSize: 26 }}>{project.name}</h1>
            <div className="muted">
              {project.phase.charAt(0).toUpperCase() + project.phase.slice(1)} phase
              {project.due_date ? ` · due ${formatDate(project.due_date, true)}` : ''}
            </div>
          </div>
          <Badge color="#94a3b8" dot={false}>Read-only view</Badge>
        </div>
        {project.description && <p className="muted">{project.description}</p>}
        <div className="card card-pad stack" style={{ gap: 8 }}>
          <div className="row between"><b>Overall progress</b><b>{project.progress}%</b></div>
          <Progress value={project.progress} color={project.color} />
          <div className="small muted">{project.done_count} of {project.issue_count} work items finished</div>
        </div>

        {data.milestones && (
          <div>
            <h2 className="icon-label"><Flag size={17} /> <span>Milestones</span></h2>
            <div className="card">
              {data.milestones.length === 0 ? <div className="card-pad muted">No milestones yet.</div> : data.milestones.map((m, n) => (
                <div className="list-row" key={n} style={{ cursor: 'default' }}>
                  <span className="grow"><b>{m.name}</b><div className="small muted">{m.due_date ? `Due ${formatDate(m.due_date, true)}` : 'No date'} · {m.progress}% done</div></span>
                  <Badge color={byKey(MILESTONE_STAGES, m.stage).color}>{byKey(MILESTONE_STAGES, m.stage).label}</Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.features && (
          <div>
            <h2 className="icon-label"><Layers size={17} /> <span>Features</span></h2>
            <div className="card">
              {data.features.length === 0 ? <div className="card-pad muted">No features yet.</div> : data.features.map((f, n) => (
                <div className="list-row" key={n} style={{ cursor: 'default' }}>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <b>{f.title}</b>
                    <div className="small muted">{f.target_date ? `Target ${formatDate(f.target_date, true)}` : 'No target date'}{f.release ? ` · release ${f.release}` : ''}</div>
                    <div style={{ maxWidth: 260, marginTop: 5 }}><Progress value={f.progress} color={byKey(FEATURE_STAGES, f.stage).color} /></div>
                  </span>
                  <Badge color={byKey(FEATURE_STAGES, f.stage).color}>{byKey(FEATURE_STAGES, f.stage).label}</Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.releases && (
          <div>
            <h2 className="icon-label"><Rocket size={17} /> <span>Releases</span></h2>
            <div className="card">
              {data.releases.length === 0 ? <div className="card-pad muted">No releases planned yet.</div> : data.releases.map((r, n) => (
                <div className="list-row" key={n} style={{ cursor: 'default' }}>
                  <span className="grow"><b>{r.version}</b><div className="small muted">{r.environment}{r.deployed_at ? ` · deployed ${formatDate(r.deployed_at, true)}` : r.planned_date ? ` · planned ${formatDate(r.planned_date, true)}` : ''}</div></span>
                  <Badge color={byKey(RELEASE_STATUSES, r.status).color}>{byKey(RELEASE_STATUSES, r.status).label}</Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.issues && (
          <div>
            <h2 className="icon-label"><CalendarDays size={17} /> <span>Open work ({data.issues.open.length})</span></h2>
            <div className="card">
              {data.issues.open.length === 0 ? <div className="card-pad muted">Nothing open right now.</div> : data.issues.open.map((i) => (
                <div className="list-row" key={i.key} style={{ cursor: 'default' }}>
                  <span className="issue-key">{i.key}</span>
                  <span className="grow truncate">{i.title}</span>
                  <span className="small muted hide-mobile">{byKey(PRIORITIES, i.priority).label}</span>
                  {i.due_date && <span className="small muted">{formatDate(i.due_date)}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        {data.allow_feedback && <ClientFeedback token={token} data={data} />}
        <p className="small faint" style={{ textAlign: 'center' }}>Shared by {workspace.name}. This page always shows the latest progress.</p>
      </section>
    </div>
  )
}

/* ───────────── Client comments and approvals on a share page ───────────── */

function ClientFeedback({ token, data }) {
  const [items, setItems] = useState([])
  const [form, setForm] = useState(() => {
    let name = ''
    try {
      name = localStorage.getItem('pm_client_name') || ''
    } catch {
      /* ignore */
    }
    return { name, body: '', target: 'project', kind: 'comment' }
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const load = () => api(`/public/share/${token}/feedback`).then((r) => setItems(r.items)).catch(() => {})
  useEffect(() => { load() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  const targets = [
    { key: 'project', label: 'The whole project' },
    ...(data.milestones || []).map((m) => ({ key: `milestone:${m.id}`, label: `Milestone: ${m.name}` })),
    ...(data.features || []).map((f) => ({ key: `feature:${f.id}`, label: `Feature: ${f.title}` })),
  ]
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const [target_type, id] = form.target.split(':')
    const kind = e.nativeEvent.submitter?.value === 'approval' ? 'approval' : 'comment'
    try {
      await api(`/public/share/${token}/feedback`, { method: 'POST', body: { name: form.name, body: form.body, kind, target_type, target_id: id ? Number(id) : null } })
      try {
        localStorage.setItem('pm_client_name', form.name)
      } catch {
        /* ignore */
      }
      setForm({ ...form, body: '', kind: 'comment' })
      setSent(true)
      load()
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }
  return (
    <div>
      <h2 className="icon-label"><MessageSquare size={17} /> <span>Your feedback</span></h2>
      <form className="card card-pad stack" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        {sent && <div className="form-success">Thank you. The team has been told.</div>}
        <div className="form-grid">
          <Field label="Your name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} required /></Field>
          <Field label="About">
            <select className="select" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}>
              {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Message"><textarea className="textarea" rows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} maxLength={5000} placeholder="A question, a change you would like, or anything the team should know" /></Field>
        <div className="row row-wrap" style={{ gap: 8 }}>
          <button className="btn btn-primary" disabled={busy} value="comment">{busy ? <Spinner /> : 'Send comment'}</button>
          <button className="btn" disabled={busy} value="approval" title="Tell the team you are happy with this"><ThumbsUp size={14} /> Approve</button>
        </div>
      </form>
      {items.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          {items.map((f) => (
            <div className="list-row" key={f.id} style={{ cursor: 'default', alignItems: 'flex-start' }}>
              <span className="stat-icon" style={{ '--c': f.kind === 'approval' ? '#22c55e' : 'var(--accent)', flex: 'none' }}>{f.kind === 'approval' ? <ThumbsUp size={15} /> : <MessageSquare size={15} />}</span>
              <span className="grow" style={{ minWidth: 0 }}>
                <div><b>{f.author}</b> <span className="muted">{f.kind === 'approval' ? 'approved' : 'on'}</span> {f.target_type === 'project' ? 'the project' : f.target_name} <span className="faint small">· {timeAgo(f.created_at)}</span></div>
                {f.body && <div style={{ whiteSpace: 'pre-wrap' }}>{f.body}</div>}
                {f.reply && <div className="thread-body" style={{ marginTop: 6 }}><b>The team:</b> {f.reply}</div>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ───────────── Public status page ───────────── */

export const STATE_META = {
  operational: { label: 'All systems operational', color: '#22c55e' },
  degraded: { label: 'Some things are not working normally', color: '#f59e0b' },
  major: { label: 'Major outage', color: '#ef4444' },
  maintenance: { label: 'Maintenance in progress', color: '#6366f1' },
}
const INCIDENT_STATUS = { investigating: 'Investigating', identified: 'Cause found', monitoring: 'Fix in place, watching', resolved: 'Resolved' }

export function UptimeBars({ days }) {
  return (
    <div className="uptime-bars" role="img" aria-label="Uptime for each of the last 90 days">
      {days.map((d) => (
        <i
          key={d.date}
          title={`${formatDate(d.date, true)}: ${d.uptime == null ? 'no data' : `${d.uptime}% up`}`}
          style={{ background: d.uptime == null ? 'var(--surface-3)' : d.uptime >= 99.9 ? '#22c55e' : d.uptime >= 98 ? '#f59e0b' : '#ef4444' }}
        />
      ))}
    </div>
  )
}

export function IncidentCard({ incident, children }) {
  return (
    <div className="card card-pad stack" style={{ gap: 8 }}>
      <div className="row between row-wrap">
        <b>{incident.title}</b>
        <span className="row" style={{ gap: 6 }}>
          <Badge color={incident.status === 'resolved' ? '#22c55e' : incident.impact === 'major' ? '#ef4444' : incident.impact === 'maintenance' ? '#6366f1' : '#f59e0b'}>{INCIDENT_STATUS[incident.status]}</Badge>
          {children}
        </span>
      </div>
      {[...incident.updates].reverse().map((u, n) => (
        <div className="small" key={n}><span className="faint">{formatDateTime(u.at)} · {INCIDENT_STATUS[u.status]}</span>{u.text ? <div style={{ whiteSpace: 'pre-wrap' }}>{u.text}</div> : null}</div>
      ))}
    </div>
  )
}

export function StatusPage() {
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const load = () => api('/public/status').then((d) => { setData(d); setFailed(false) }).catch(() => setFailed(true))
    load()
    const timer = setInterval(load, 60000)
    return () => clearInterval(timer)
  }, [])
  const meta = failed ? STATE_META.major : data ? STATE_META[data.state] : null
  return (
    <PublicShell company={data?.company_name}>
      <section className="public-section legal">
        <h1 className="icon-label"><Activity size={24} /> <span>Service status</span></h1>
        {!meta ? <Spinner /> : (
          <>
            <div className="status-hero" style={{ '--c': meta.color }}>
              <span className="status-dot" />
              <div>
                <b>{failed ? 'The service cannot be reached right now' : meta.label}</b>
                {data?.checked_at && !failed && <div className="small">Checked {timeAgo(data.checked_at)}</div>}
              </div>
            </div>
            {data && (
              <>
                {data.open_incidents.map((i) => <IncidentCard key={i.id} incident={i} />)}
                <div className="card card-pad stack" style={{ gap: 10 }}>
                  <div className="row between"><b>Uptime, last 90 days</b><b>{data.uptime == null ? 'No data yet' : `${data.uptime}%`}</b></div>
                  <UptimeBars days={data.days} />
                  <div className="row between small faint"><span>90 days ago</span><span>Today</span></div>
                  {data.monitoring_since && <div className="small muted">Measured every minute since {formatDate(data.monitoring_since, true)}.</div>}
                </div>
                <div>
                  <h2 style={{ fontSize: 17, marginBottom: 10 }}>Past incidents</h2>
                  {data.past_incidents.length === 0 ? <p className="muted">No incidents reported.</p> : <div className="stack">{data.past_incidents.map((i) => <IncidentCard key={i.id} incident={i} />)}</div>}
                </div>
              </>
            )}
          </>
        )}
      </section>
    </PublicShell>
  )
}
