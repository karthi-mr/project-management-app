import { useCallback, useEffect, useState } from 'react'
import { Megaphone, Pencil, Plus, Snowflake, Tag, Trash2, LifeBuoy } from 'lucide-react'
import { api } from '../api'
import { useConfirm, useToast } from '../context'
import { Badge, Empty, Field, Modal, PageSkeleton, Spinner, formatDate, timeAgo } from '../ui'
import { LicenseBadge, money } from '../components/License'
import { TICKET_STATUS, TicketThread } from './Support'
import { IncidentCard, STATE_META, UptimeBars } from './Public'

/* ───────────── Usage analytics ───────────── */

function WorkspaceRows({ rows, onOpen, empty, extra }) {
  if (rows.length === 0) return <div className="card-pad muted small">{empty}</div>
  return rows.map((o) => (
    <button className="list-row" key={o.id} onClick={() => onOpen(o.id)}>
      <span className="grow" style={{ minWidth: 0 }}>
        <b>{o.name}</b> <span className="faint small">{o.plan} · {o.users} {o.users === 1 ? 'user' : 'users'}</span>
        <div className="small muted">{extra(o)}</div>
      </span>
      <LicenseBadge status={o.status} />
    </button>
  ))
}

export function Analytics({ onOpen }) {
  const [data, setData] = useState(null)
  useEffect(() => { api('/platform/analytics').then(setData).catch(() => setData(false)) }, [])
  if (data === false) return <div className="form-error">Could not load analytics.</div>
  if (!data) return <PageSkeleton padded={false} />
  const peak = Math.max(1, ...data.weeks.map((w) => w.signups))
  const idle = (o) => (o.idle_days == null ? 'never signed in' : o.idle_days === 0 ? 'active today' : `last sign-in ${o.idle_days} days ago`)
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="grid grid-3">
        <div className="card stat">
          <div className="stat-top"><span>Active this week</span></div>
          <div className="stat-value">{data.active_7_days}<span className="stat-of"> of {data.workspaces}</span></div>
          <div className="small muted">{data.active_30_days} workspaces active in the last 30 days</div>
        </div>
        <div className="card stat">
          <div className="stat-top"><span>Trial to paid</span></div>
          <div className="stat-value">{data.conversion_rate == null ? '—' : `${data.conversion_rate}%`}</div>
          <div className="small muted">{data.trials_converted} of {data.trials_finished} finished trials became customers</div>
        </div>
        <div className="card stat">
          <div className="stat-top"><span>Trials going cold</span></div>
          <div className="stat-value">{data.cold_trials.length}</div>
          <div className="small muted">Quiet for 4+ days, or ending within 3 days with no request</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><h2>New workspaces per week</h2></div>
        <div className="card-body">
          <div className="week-bars" role="img" aria-label="Sign-ups in each of the last 12 weeks">
            {data.weeks.map((w) => (
              <div key={w.week} className="week-bar" title={`Week of ${formatDate(w.week, true)}: ${w.signups}`}>
                <b>{w.signups || ''}</b>
                <i style={{ height: `${Math.max(3, (w.signups / peak) * 100)}%`, opacity: w.signups ? 1 : 0.25 }} />
                <span>{formatDate(w.week)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-header"><h2 className="icon-label"><Snowflake size={16} /> <span>Trials going cold</span></h2></div>
          <WorkspaceRows rows={data.cold_trials} onOpen={onOpen} empty="No trials need attention." extra={(o) => `${idle(o)} · ${o.days_left} days of trial left`} />
        </div>
        <div className="card">
          <div className="card-header"><h2>Paying but quiet</h2></div>
          <WorkspaceRows rows={data.paying_but_quiet} onOpen={onOpen} empty="Every paying workspace has been active in the last two weeks." extra={(o) => `${idle(o)} · may not renew`} />
        </div>
      </div>

      <div className="card">
        <div className="card-header"><h2>Most active (issues created in 30 days)</h2></div>
        <WorkspaceRows rows={data.most_active.filter((o) => o.issues_30_days > 0)} onOpen={onOpen} empty="No activity yet." extra={(o) => `${o.issues_30_days} issues created · ${idle(o)}`} />
      </div>
    </div>
  )
}

/* ───────────── Coupons ───────────── */

function CouponModal({ coupon, currency, onClose, onSaved }) {
  const toast = useToast()
  const [form, setForm] = useState(coupon
    ? { ...coupon, max_uses: coupon.max_uses ?? '', expires_on: coupon.expires_on || '' }
    : { code: '', description: '', percent_off: 10, amount_off: 0, max_uses: '', expires_on: '', active: true })
  const [busy, setBusy] = useState(false)
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const body = {
        code: form.code, description: form.description, percent_off: Number(form.percent_off) || 0, amount_off: Number(form.amount_off) || 0,
        max_uses: form.max_uses === '' ? null : Number(form.max_uses), expires_on: form.expires_on || null, active: form.active,
      }
      await api(coupon ? `/platform/coupons/${coupon.id}` : '/platform/coupons', { method: coupon ? 'PUT' : 'POST', body })
      toast(coupon ? 'Coupon updated' : 'Coupon created')
      onSaved()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }
  return (
    <Modal title={coupon ? `Edit ${coupon.code}` : 'New coupon'} onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <div className="modal-body stack">
          <Field label="Code" hint="What the customer types. Letters, numbers, dashes."><input className="input mono" value={form.code} onChange={set('code')} disabled={Boolean(coupon)} minLength={3} maxLength={40} pattern="[A-Za-z0-9_\-]+" required autoFocus /></Field>
          <Field label="Description"><input className="input" value={form.description} onChange={set('description')} maxLength={200} placeholder="For example: launch offer" /></Field>
          <div className="form-grid">
            <Field label="Percent off"><input className="input" type="number" min="0" max="100" step="any" value={form.percent_off} onChange={set('percent_off')} /></Field>
            <Field label={`Amount off (${currency})`}><input className="input" type="number" min="0" step="any" value={form.amount_off} onChange={set('amount_off')} /></Field>
            <Field label="Maximum uses" hint="Empty = unlimited."><input className="input" type="number" min="1" value={form.max_uses} onChange={set('max_uses')} /></Field>
            <Field label="Valid until" hint="Empty = no end date."><input className="input" type="date" value={form.expires_on} onChange={set('expires_on')} /></Field>
          </div>
          <label className="opt-row"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Save coupon'}</button>
        </div>
      </form>
    </Modal>
  )
}

export function Coupons({ currency }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [rows, setRows] = useState(null)
  const [editing, setEditing] = useState(null)
  const load = useCallback(() => api('/platform/coupons').then(setRows).catch(() => setRows([])), [])
  useEffect(() => { load() }, [load])
  const remove = async (c) => {
    if (!(await confirm({ title: `Delete coupon ${c.code}?`, message: 'It can no longer be used. Past invoices keep their discount.', confirmLabel: 'Delete coupon', danger: true }))) return
    try {
      await api(`/platform/coupons/${c.id}`, { method: 'DELETE' })
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  if (!rows) return <PageSkeleton variant="list" padded={false} />
  return (
    <>
      <div className="toolbar">
        <span className="muted small grow">Customers enter a code when they request a plan. For one customer's standing discount or a custom price, open the workspace or adjust the amount when you activate.</span>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> New coupon</button>
      </div>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>Code</th><th>Discount</th><th>Used</th><th>Valid until</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td><b className="mono">{c.code}</b><div className="faint small">{c.description}</div></td>
                <td>{[c.percent_off ? `${c.percent_off}%` : '', c.amount_off ? money(c.amount_off, currency) : ''].filter(Boolean).join(' + ')} off</td>
                <td>{c.used}{c.max_uses != null && <span className="faint"> / {c.max_uses}</span>}</td>
                <td className="small muted">{c.expires_on ? formatDate(c.expires_on, true) : 'No end date'}</td>
                <td>{c.usable ? <Badge color="#22c55e">Usable</Badge> : <Badge color="#94a3b8">{c.active ? 'Used up or expired' : 'Off'}</Badge>}</td>
                <td>
                  <span className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                    <button className="btn btn-ghost btn-sm btn-icon" aria-label={`Edit ${c.code}`} onClick={() => setEditing(c)}><Pencil size={14} /></button>
                    <button className="btn btn-ghost btn-sm btn-icon danger-text" aria-label={`Delete ${c.code}`} onClick={() => remove(c)}><Trash2 size={14} /></button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty icon={Tag} title="No coupons yet">Create a code to give new customers a discount.</Empty>}
      </div>
      {editing && <CouponModal coupon={editing === 'new' ? null : editing} currency={currency} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
    </>
  )
}

/* ───────────── Announcements ───────────── */

export function Announcements() {
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [form, setForm] = useState({ title: '', body: '', level: 'info', audience: 'all', expires_in_days: '' })
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => api('/platform/announcements').then(setRows).catch(() => setRows([])), [])
  useEffect(() => { load() }, [load])
  const post = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api('/platform/announcements', { method: 'POST', body: { ...form, expires_in_days: form.expires_in_days ? Number(form.expires_in_days) : null } })
      toast('Announcement posted to every workspace')
      setForm({ title: '', body: '', level: 'info', audience: 'all', expires_in_days: '' })
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
    setBusy(false)
  }
  const act = async (fn) => {
    try {
      await fn()
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  return (
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <form className="card card-pad stack" onSubmit={post}>
        <h2>Post an announcement</h2>
        <Field label="Title"><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={160} required placeholder="For example: Maintenance on Sunday, 2 to 3 am" /></Field>
        <Field label="Details (optional)"><textarea className="textarea" rows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} maxLength={5000} /></Field>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <Field label="Kind">
            <select className="select" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}><option value="info">News</option><option value="warning">Warning</option></select>
          </Field>
          <Field label="Shown to">
            <select className="select" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}><option value="all">Everyone</option><option value="admins">Administrators</option></select>
          </Field>
          <Field label="Shown for">
            <select className="select" value={form.expires_in_days} onChange={(e) => setForm({ ...form, expires_in_days: e.target.value })}><option value="">Until removed</option><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option></select>
          </Field>
        </div>
        <div><button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : <><Megaphone size={15} /> Post</>}</button></div>
      </form>
      <div className="card">
        <div className="card-header"><h2>Posted</h2></div>
        {!rows ? <div className="card-pad"><Spinner /></div> : rows.length === 0 ? <Empty icon={Megaphone} title="Nothing posted yet" /> : rows.map((a) => (
          <div className="list-row" key={a.id} style={{ cursor: 'default', alignItems: 'flex-start' }}>
            <span className="grow" style={{ minWidth: 0 }}>
              <b>{a.title}</b> {a.live ? <Badge color={a.level === 'warning' ? '#f59e0b' : '#6366f1'}>Showing</Badge> : <Badge color="#94a3b8">Hidden</Badge>}
              {a.body && <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{a.body}</div>}
              <div className="small faint">{a.audience === 'admins' ? 'Administrators' : 'Everyone'} · posted {timeAgo(a.created_at)}{a.expires_at ? ` · until ${formatDate(a.expires_at, true)}` : ''}</div>
            </span>
            <button className="btn btn-sm" onClick={() => act(() => api(`/platform/announcements/${a.id}`, { method: 'PATCH', body: { active: !a.active } }))}>{a.active ? 'Hide' : 'Show'}</button>
            <button className="btn btn-ghost btn-sm btn-icon danger-text" aria-label="Delete announcement" onClick={() => act(() => api(`/platform/announcements/${a.id}`, { method: 'DELETE' }))}><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ───────────── Support inbox ───────────── */

export function SupportInbox({ onChanged }) {
  const [data, setData] = useState(null)
  const [filter, setFilter] = useState('open')
  const [open, setOpen] = useState(null)
  const load = useCallback(() => api(`/platform/support${filter ? `?status=${filter}` : ''}`).then(setData).catch(() => setData({ tickets: [] })), [filter])
  useEffect(() => { load() }, [load])
  return (
    <>
      <div className="toolbar">
        <div className="segmented">
          {[['open', 'Needs a reply'], ['answered', 'Answered'], ['closed', 'Closed'], ['', 'All']].map(([key, label]) => (
            <button key={key} className={filter === key ? 'active' : ''} onClick={() => { setData(null); setFilter(key) }}>{label}</button>
          ))}
        </div>
      </div>
      {!data ? <PageSkeleton variant="list" padded={false} /> : (
        <div className="card">
          {data.tickets.length === 0 ? <Empty icon={LifeBuoy} title={filter === 'open' ? 'Nothing is waiting for a reply' : 'No conversations'}>Customers write to you from “Help and support” in their workspace.</Empty> : data.tickets.map((t) => (
            <button className="list-row" key={t.id} onClick={() => setOpen(t.id)}>
              <span className="grow" style={{ minWidth: 0 }}>
                <div><b>{t.subject}</b> <span className="faint small">{t.org_name} · {t.user_name}</span></div>
                <div className="small muted truncate">{t.last_from_staff ? 'You: ' : ''}{t.preview}</div>
              </span>
              <span className="small faint hide-mobile">{timeAgo(t.updated_at)}</span>
              <Badge color={TICKET_STATUS[t.status].color}>{TICKET_STATUS[t.status].staffLabel}</Badge>
            </button>
          ))}
        </div>
      )}
      {open && <TicketThread ticketId={open} base="/platform/support" staff onClose={() => { setOpen(null); load(); onChanged?.() }} onChanged={load} />}
    </>
  )
}

/* ───────────── Status and incidents ───────────── */

export function StatusAdmin() {
  const toast = useToast()
  const [data, setData] = useState(null)
  const [form, setForm] = useState({ title: '', impact: 'minor', text: '' })
  const [updating, setUpdating] = useState(null)
  const [update, setUpdate] = useState({ status: 'identified', text: '' })
  const load = useCallback(() => api('/platform/status').then(setData).catch(() => setData(false)), [])
  useEffect(() => { load() }, [load])
  const act = async (fn, message) => {
    try {
      await fn()
      if (message) toast(message)
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  if (data === false) return <div className="form-error">Could not load the status.</div>
  if (!data) return <PageSkeleton padded={false} />
  const meta = STATE_META[data.state]
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="status-hero" style={{ '--c': meta.color }}>
        <span className="status-dot" />
        <div className="grow">
          <b>{meta.label}</b>
          <div className="small">Database answered in {data.response_ms ?? '—'} ms · checked {timeAgo(data.checked_at)} · {data.uptime ?? '—'}% up over the measured period</div>
        </div>
        <a className="btn btn-sm" href="/status" target="_blank" rel="noreferrer">Open the public page</a>
      </div>
      <div className="card card-pad stack" style={{ gap: 10 }}>
        <b>Uptime, last 90 days</b>
        <UptimeBars days={data.days} />
        <div className="small muted">The service checks itself every minute. A gap in those checks, for example while the server is switched off, counts as downtime. Because it cannot tell you while it is down, also point an outside monitor at <code>/api/health</code>.</div>
        {data.failed_checks.length > 0 && <div className="small danger-text">Last failed check {timeAgo(data.failed_checks[0].at)}: {data.failed_checks[0].detail}</div>}
      </div>
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <form className="card card-pad stack" onSubmit={(e) => { e.preventDefault(); act(() => api('/platform/incidents', { method: 'POST', body: form }).then(() => setForm({ title: '', impact: 'minor', text: '' })), 'Incident posted on the status page') }}>
          <h2>Report an incident</h2>
          <Field label="What is wrong"><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} minLength={3} maxLength={200} required placeholder="For example: pages are loading slowly" /></Field>
          <Field label="Kind">
            <select className="select" value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })}>
              <option value="minor">Minor problem</option><option value="major">Major outage</option><option value="maintenance">Planned maintenance</option>
            </select>
          </Field>
          <Field label="Details (optional)"><textarea className="textarea" rows={3} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} /></Field>
          <div><button className="btn btn-primary">Post to the status page</button></div>
        </form>
        <div className="stack">
          {data.open_incidents.length === 0 && data.past_incidents.length === 0 && <div className="card"><Empty icon={Megaphone} title="No incidents">Anything you report here appears on the public status page.</Empty></div>}
          {[...data.open_incidents, ...data.past_incidents].map((i) => (
            <IncidentCard key={i.id} incident={i}>
              {i.status !== 'resolved' && <button className="btn btn-sm" onClick={() => { setUpdating(i.id); setUpdate({ status: 'resolved', text: '' }) }}>Update</button>}
              <button className="btn btn-ghost btn-sm btn-icon danger-text" aria-label="Delete incident" onClick={() => act(() => api(`/platform/incidents/${i.id}`, { method: 'DELETE' }))}><Trash2 size={14} /></button>
            </IncidentCard>
          ))}
        </div>
      </div>
      {updating && (
        <Modal title="Update the incident" onClose={() => setUpdating(null)} size="sm">
          <form onSubmit={(e) => { e.preventDefault(); act(() => api(`/platform/incidents/${updating}/updates`, { method: 'POST', body: update }).then(() => setUpdating(null)), 'Status page updated') }}>
            <div className="modal-body stack">
              <Field label="Now">
                <select className="select" value={update.status} onChange={(e) => setUpdate({ ...update, status: e.target.value })}>
                  <option value="investigating">Still investigating</option><option value="identified">Cause found</option><option value="monitoring">Fix in place, watching</option><option value="resolved">Resolved</option>
                </select>
              </Field>
              <Field label="What to tell customers"><textarea className="textarea" rows={3} value={update.text} onChange={(e) => setUpdate({ ...update, text: e.target.value })} autoFocus /></Field>
            </div>
            <div className="modal-footer"><button type="button" className="btn btn-ghost" onClick={() => setUpdating(null)}>Cancel</button><button className="btn btn-primary">Post update</button></div>
          </form>
        </Modal>
      )}
    </div>
  )
}
