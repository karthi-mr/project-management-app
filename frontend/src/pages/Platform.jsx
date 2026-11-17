import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Ban, Building2, CalendarPlus, Check, CircleDollarSign, Copy, CreditCard, FileText, Hourglass, Info,
  Pencil, Plus, RotateCcw, Search, Trash2, TrendingUp, Users, X,
} from 'lucide-react'
import { api, notifyChanged } from '../api'
import { useConfirm, useToast } from '../context'
import { Badge, Empty, Field, Modal, PageSkeleton, Spinner, formatDate, timeAgo } from '../ui'
import { Analytics, Announcements, Coupons, StatusAdmin, SupportInbox } from './PlatformExtras'
import { FEATURE_LABELS, InvoiceModal, LicenseBadge, RequestBadge, money, seatsText } from '../components/License'

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'workspaces', label: 'Workspaces' },
  { key: 'requests', label: 'License requests' },
  { key: 'plans', label: 'Plans' },
  { key: 'addons', label: 'Add-ons' },
  { key: 'coupons', label: 'Coupons' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'analytics', label: 'Analytics' },
  { key: 'support', label: 'Support' },
  { key: 'announcements', label: 'Announcements' },
  { key: 'status', label: 'Status' },
  { key: 'settings', label: 'Settings' },
]

const dateInput = (iso) => (iso ? iso.slice(0, 10) : '')
const addDays = (iso, days) => {
  const base = iso && new Date(iso) > new Date() ? new Date(iso) : new Date()
  base.setDate(base.getDate() + days)
  return base.toISOString().slice(0, 10)
}

function Stat({ icon: Icon, label, value, color, hint }) {
  return (
    <div className="card stat">
      <div className="stat-top"><span>{label}</span><span className="stat-icon" style={{ '--c': color }}><Icon size={16} /></span></div>
      <div className="stat-value">{value}</div>
      {hint && <div className="small muted">{hint}</div>}
    </div>
  )
}

/* ───────────── Overview ───────────── */

function Overview({ onOpen, goTo }) {
  const [data, setData] = useState(null)
  useEffect(() => { api('/platform/overview').then(setData).catch(() => setData(false)) }, [])
  if (data === false) return <div className="form-error">Could not load the overview.</div>
  if (!data) return <PageSkeleton padded={false} />
  const s = data.by_status
  return (
    <>
      {data.pending_requests > 0 && (
        <div className="callout" style={{ marginBottom: 16, alignItems: 'center' }}>
          <Hourglass size={16} />
          <span className="grow">{data.pending_requests} license {data.pending_requests === 1 ? 'request is' : 'requests are'} waiting for you to confirm the payment and activate.</span>
          <button className="btn btn-primary btn-sm" onClick={() => goTo('requests')}>Review</button>
        </div>
      )}
      <div className="grid grid-stats" style={{ marginBottom: 18 }}>
        <Stat icon={Building2} label="Workspaces" value={data.workspaces} color="#6366f1" hint={`${data.new_30_days} new in 30 days`} />
        <Stat icon={Check} label="Paying" value={s.active} color="#22c55e" hint={`${s.trial} on trial`} />
        <Stat icon={Ban} label="Expired or suspended" value={s.expired + s.suspended} color="#ef4444" hint={`${s.expired} expired · ${s.suspended} suspended`} />
        <Stat icon={TrendingUp} label="Monthly recurring" value={money(data.mrr, data.currency)} color="#06b6d4" hint={`${money(data.revenue_30_days, data.currency)} received in 30 days`} />
        <Stat icon={CircleDollarSign} label="Total received" value={money(data.revenue_total, data.currency)} color="#f59e0b" hint={`${data.users} users · ${data.projects} projects`} />
      </div>
      <div className="card">
        <div className="card-header"><h2>Ending in the next 14 days</h2></div>
        {data.expiring_soon.length === 0 ? <Empty icon={Hourglass} title="Nothing is about to end" /> : data.expiring_soon.map((o) => (
          <button className="list-row" key={o.id} onClick={() => onOpen(o.id)}>
            <span className="grow">
              <b>{o.name}</b> <span className="faint small">{o.plan?.name}{o.contact ? ` · ${o.contact.email}` : ''}</span>
            </span>
            <LicenseBadge status={o.status} />
            <span className="small muted" style={{ minWidth: 90, textAlign: 'right' }}>{o.days_left === 0 ? 'today' : `${o.days_left} days left`}</span>
          </button>
        ))}
      </div>
    </>
  )
}

/* ───────────── Workspaces ───────────── */

function NewWorkspaceModal({ onClose, onCreated }) {
  const toast = useToast()
  const [form, setForm] = useState({ name: '', admin_full_name: '', admin_email: '', admin_username: '' })
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      setResult(await api('/platform/organizations', { method: 'POST', body: form }))
      onCreated()
    } catch (err) {
      toast(err.message, 'error')
    }
    setBusy(false)
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.temporary_password)
      toast('Password copied')
    } catch {
      toast('Could not copy the password', 'error')
    }
  }
  if (result) {
    return (
      <Modal title="Workspace created" onClose={onClose} size="sm">
        <div className="modal-body stack">
          <p className="muted">Give the administrator of <b>{result.organization.name}</b> these sign-in details through a private channel.</p>
          <Field label="Workspace ID" as="div"><div className="secret-box"><code>{result.organization.public_id}</code></div></Field>
          <Field label="Username" as="div"><div className="secret-box"><code>{result.username}</code></div></Field>
          <Field label="Temporary password" as="div">
            <div className="secret-box"><code>{result.temporary_password}</code><button className="btn btn-sm" onClick={copy}><Copy size={14} /> Copy</button></div>
          </Field>
          <div className="callout"><Info size={16} /><span>Shown only once. They choose a new password when they first sign in. The workspace starts on the free trial.</span></div>
        </div>
        <div className="modal-footer"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
      </Modal>
    )
  }
  return (
    <Modal title="New workspace" onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <div className="modal-body stack">
          <Field label="Company or team name"><input className="input" value={form.name} onChange={set('name')} minLength={2} maxLength={120} required autoFocus /></Field>
          <Field label="Administrator's name"><input className="input" value={form.admin_full_name} onChange={set('admin_full_name')} required /></Field>
          <Field label="Administrator's email"><input className="input" type="email" value={form.admin_email} onChange={set('admin_email')} required /></Field>
          <Field label="Username" hint="Letters, numbers, dots, dashes and underscores."><input className="input" value={form.admin_username} onChange={set('admin_username')} minLength={3} maxLength={50} required /></Field>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Create workspace'}</button>
        </div>
      </form>
    </Modal>
  )
}

/** Which add-ons a workspace has, and which of them it got free of charge. */
function WorkspaceAddons({ org, addons, busy, onSave }) {
  const [have, setHave] = useState(() => new Set(org.addons.map((a) => a.key)))
  const [free, setFree] = useState(() => new Set(org.addons.filter((a) => a.free).map((a) => a.key)))
  const flip = (set, setter, key) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setter(next)
  }
  if (!addons?.length) return null
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="section-title">Add-ons</div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Add-on</th><th>Has it</th><th>Free of charge</th></tr></thead>
          <tbody>
            {addons.map((a) => (
              <tr key={a.key}>
                <td><b>{a.name}</b>{org.plan_features && a.features.every((f) => org.plan_features.includes(f)) && <span className="faint small"> · included in the plan</span>}</td>
                <td><input type="checkbox" aria-label={`${a.name}: has it`} checked={have.has(a.key) || free.has(a.key)} onChange={() => flip(have, setHave, a.key)} /></td>
                <td><input type="checkbox" aria-label={`${a.name}: free of charge`} checked={free.has(a.key)} onChange={() => flip(free, setFree, a.key)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row between row-wrap">
        <span className="hint">Free add-ons stay when the workspace buys a licence without them; the others follow each licence.</span>
        <button type="button" className="btn" disabled={busy} onClick={() => onSave([...new Set([...have, ...free])], [...free])}>Save add-ons</button>
      </div>
    </div>
  )
}

function WorkspaceModal({ orgId, plans, addons, onClose, onChanged, onInvoice }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [org, setOrg] = useState(null)
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)

  const fill = (o) => {
    setOrg(o)
    setForm({
      name: o.name, plan_id: o.plan?.id ?? '', seats: o.purchased_seats ?? '', unlimited: o.purchased_seats == null,
      valid_until: dateInput(o.valid_until), never: o.valid_until == null, is_trial: o.is_trial, notes: o.notes || '',
      discount: o.discount_percent || 0,
    })
  }
  const load = useCallback(() => api(`/platform/organizations/${orgId}`).then(fill).catch((e) => toast(e.message, 'error')), [orgId, toast])
  useEffect(() => { load() }, [load])

  const patch = async (body, message) => {
    setBusy(true)
    try {
      await api(`/platform/organizations/${orgId}`, { method: 'PATCH', body })
      toast(message)
      await load()
      onChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
    setBusy(false)
  }

  const save = (e) => {
    e.preventDefault()
    if (!form.never && !form.valid_until) return toast('Choose an end date, or tick “Never expires”', 'error')
    if (!form.unlimited && !form.seats) return toast('Enter the number of users, or tick “Unlimited”', 'error')
    patch({
      name: form.name, plan_id: Number(form.plan_id) || null, is_trial: form.is_trial, notes: form.notes,
      discount_percent: Number(form.discount) || 0,
      ...(form.unlimited ? { unlimited_seats: true } : { seats: Number(form.seats) }),
      ...(form.never ? { never_expires: true } : { valid_until: form.valid_until }),
    }, 'License updated')
  }

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${org.name}?`,
      message: `This permanently deletes the workspace with its ${org.usage.users} users and ${org.usage.projects} projects. It cannot be undone.`,
      confirmLabel: 'Delete workspace', danger: true,
    })
    if (!ok) return
    try {
      await api(`/platform/organizations/${orgId}`, { method: 'DELETE' })
      toast('Workspace deleted')
      onChanged()
      onClose()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <Modal title={org ? org.name : 'Workspace'} onClose={onClose} size="lg">
      {!org || !form ? <div className="modal-body"><Spinner /></div> : (
        <>
          <div className="modal-body stack" style={{ gap: 18 }}>
            <div className="row row-wrap" style={{ gap: 10 }}>
              <LicenseBadge status={org.status} />
              <span className="muted small">
                Workspace ID {org.public_id} · {org.usage.users} users · {org.usage.projects} projects · created {formatDate(org.created_at, true)}
                {org.last_activity ? ` · last sign-in ${timeAgo(org.last_activity)}` : ''}
              </span>
              {org.license_key && <code className="mono small faint">{org.license_key}</code>}
            </div>

            <form className="stack" onSubmit={save}>
              <div className="form-grid">
                <Field label="Workspace name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} minLength={2} required /></Field>
                <Field label="Plan">
                  <select className="select" value={form.plan_id} onChange={(e) => setForm({ ...form, plan_id: e.target.value })}>
                    {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Field>
                <Field label="Users (seats)" as="div">
                  <input className="input" type="number" min="1" value={form.unlimited ? '' : form.seats} disabled={form.unlimited} placeholder={form.unlimited ? 'Unlimited' : ''} onChange={(e) => setForm({ ...form, seats: e.target.value })} />
                  <label className="opt-row"><input type="checkbox" checked={form.unlimited} onChange={(e) => setForm({ ...form, unlimited: e.target.checked })} /> Unlimited (the plan's own limit still applies)</label>
                </Field>
                <Field label="Valid until" as="div">
                  <input className="input" type="date" value={form.never ? '' : form.valid_until} disabled={form.never} onChange={(e) => setForm({ ...form, valid_until: e.target.value })} />
                  <span className="row row-wrap" style={{ gap: 6 }}>
                    {[14, 30, 365].map((d) => (
                      <button type="button" key={d} className="btn btn-sm" disabled={form.never} onClick={() => setForm({ ...form, valid_until: addDays(form.valid_until, d) })}><CalendarPlus size={13} /> +{d} days</button>
                    ))}
                  </span>
                  <label className="opt-row"><input type="checkbox" checked={form.never} onChange={(e) => setForm({ ...form, never: e.target.checked })} /> Never expires</label>
                </Field>
              </div>
              <label className="opt-row"><input type="checkbox" checked={form.is_trial} onChange={(e) => setForm({ ...form, is_trial: e.target.checked })} /> This is a free trial (not a paid license)</label>
              <Field label="Standing discount (%)" hint="Taken off every request this workspace sends, for example a price you agreed with them.">
                <input className="input" type="number" min="0" max="100" step="any" style={{ maxWidth: 140 }} value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} />
              </Field>
              <Field label="Private notes" hint="Only you can see these."><textarea className="textarea" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
              <WorkspaceAddons key={org.addons.map((a) => a.key + a.free).join()} org={org} addons={addons} busy={busy} onSave={(list, freeList) => patch({ addons: list, free_addons: freeList }, 'Add-ons updated')} />
              <div className="row between row-wrap">
                <span className="row" style={{ gap: 6 }}>
                  {org.suspended ? (
                    <>
                      <button type="button" className="btn" disabled={busy} onClick={() => patch({ suspended: false }, 'Workspace reactivated')}><RotateCcw size={14} /> Reactivate</button>
                      <button type="button" className="btn btn-danger" onClick={remove}><Trash2 size={14} /> Delete workspace</button>
                    </>
                  ) : (
                    <button type="button" className="btn" disabled={busy} onClick={() => patch({ suspended: true }, 'Workspace suspended')}><Ban size={14} /> Suspend</button>
                  )}
                </span>
                <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Save license'}</button>
              </div>
            </form>

            <div>
              <div className="section-title">People ({org.users.length})</div>
              <div className="card table-wrap">
                <table className="table">
                  <tbody>
                    {org.users.map((u) => (
                      <tr key={u.id}>
                        <td><b>{u.full_name}</b> <span className="faint small">@{u.username}</span></td>
                        <td className="muted">{u.email}</td>
                        <td>{u.role === 'admin' ? 'Administrator' : u.role === 'manager' ? 'Manager' : 'Member'}</td>
                        <td>{u.is_active ? <span className="muted small">{u.last_login ? `seen ${timeAgo(u.last_login)}` : 'never signed in'}</span> : <Badge color="#94a3b8">Disabled</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {org.invoices.length > 0 && (
              <div>
                <div className="section-title">Invoices</div>
                <div className="card">
                  {org.invoices.map((i) => (
                    <button className="list-row" key={i.id} onClick={() => onInvoice(i.id)}>
                      <b>{i.number}</b>
                      <span className="grow muted small">{i.plan_name} · {seatsText(i.seats)} · {i.period}</span>
                      <span>{money(i.amount, i.currency)}</span>
                      <span className="muted small">{formatDate(i.issued_at, true)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}

function Workspaces({ onOpen, version, onChanged }) {
  const [rows, setRows] = useState(null)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      const query = new URLSearchParams()
      if (q.trim()) query.set('q', q.trim())
      if (status) query.set('status', status)
      api(`/platform/organizations?${query}`).then(setRows).catch(() => setRows([]))
    }, 200)
    return () => clearTimeout(timer)
  }, [q, status, version])

  return (
    <>
      <div className="toolbar">
        <div className="input-icon">
          <Search size={15} />
          <input className="input search-input" placeholder="Search workspace, ID, person or email…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          <option value="trial">Free trial</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="suspended">Suspended</option>
        </select>
        <span className="grow" />
        <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={15} /> New workspace</button>
      </div>
      {!rows ? <PageSkeleton variant="list" padded={false} /> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Workspace</th><th>Plan</th><th>Status</th><th>Users</th><th>Projects</th><th>Valid until</th><th>Last sign-in</th></tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} className="clickable" onClick={() => onOpen(o.id)}>
                  <td><b>{o.name}</b> <span className="faint small mono">{o.public_id}</span><div className="faint small">{o.contact ? `${o.contact.name} · ${o.contact.email}` : 'No administrator'}</div></td>
                  <td>{o.plan?.name || '—'}</td>
                  <td><LicenseBadge status={o.status} /></td>
                  <td>{o.usage.users}<span className="faint"> / {o.seats ?? '∞'}</span></td>
                  <td>{o.usage.projects}<span className="faint"> / {o.max_projects ?? '∞'}</span></td>
                  <td className="small">{o.valid_until ? <>{formatDate(o.valid_until, true)}<div className={o.days_left < 0 ? 'danger-text' : 'faint'}>{o.days_left < 0 ? `${-o.days_left} days ago` : `${o.days_left} days left`}</div></> : <span className="muted">Never expires</span>}</td>
                  <td className="muted small">{o.last_activity ? timeAgo(o.last_activity) : 'Never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <Empty icon={Building2} title="No workspaces match" />}
        </div>
      )}
      {creating && <NewWorkspaceModal onClose={() => setCreating(false)} onCreated={onChanged} />}
    </>
  )
}

/* ───────────── License requests ───────────── */

function DecisionModal({ request, approve, onClose, onDone }) {
  const toast = useToast()
  const [note, setNote] = useState('')
  const [amount, setAmount] = useState(request.amount)
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api(`/platform/requests/${request.id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: approve ? { note, amount: Number(amount) } : { note } })
      toast(approve ? `License activated for ${request.org_name}` : 'Request rejected')
      onDone()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }
  return (
    <Modal title={approve ? 'Activate this license?' : 'Reject this request?'} onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <div className="modal-body stack">
          <div className="quote" style={{ alignItems: 'flex-start' }}>
            <span>
              <b>{request.org_name}</b>
              <div className="muted small">{request.plan_name}{request.addons?.length > 0 ? ` + ${request.addons.length} add-on${request.addons.length === 1 ? '' : 's'} (${request.addons.join(', ').replaceAll('_', ' ')})` : ''} · {seatsText(request.seats)} · {request.period}</div>
              <div className="muted small">Reference: {request.payment_reference || 'none given'}</div>
            </span>
            <b>{money(request.amount, request.currency)}</b>
          </div>
          {request.discount_note && <div className="small muted">List price {money(request.list_amount ?? request.amount, request.currency)}. Discount: {request.discount_note}.</div>}
          {approve && (
            <Field label={`Amount received (${request.currency})`} hint="Change this only if you agreed a different price with the customer. The invoice shows this amount.">
              <input className="input" type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </Field>
          )}
          {approve && (
            <div className="callout"><Info size={16} /><span>Check that {money(request.amount, request.currency)} has arrived in your account first. Activating starts the license, issues an invoice and tells the workspace.</span></div>
          )}
          <Field label={approve ? 'Note (optional)' : 'Reason (shown to the workspace)'}>
            <textarea className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} autoFocus />
          </Field>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className={`btn ${approve ? 'btn-primary' : 'btn-danger'}`} disabled={busy}>{busy ? <Spinner /> : approve ? 'Payment received, activate' : 'Reject request'}</button>
        </div>
      </form>
    </Modal>
  )
}

function Requests({ onOpen, onChanged }) {
  const [rows, setRows] = useState(null)
  const [filter, setFilter] = useState('pending')
  const [deciding, setDeciding] = useState(null)
  const load = useCallback(() => api(`/platform/requests${filter ? `?status=${filter}` : ''}`).then(setRows).catch(() => setRows([])), [filter])
  useEffect(() => { load() }, [load])

  return (
    <>
      <div className="toolbar">
        <div className="segmented">
          {[['pending', 'Waiting'], ['approved', 'Activated'], ['rejected', 'Rejected'], ['', 'All']].map(([key, label]) => (
            <button key={key} className={filter === key ? 'active' : ''} onClick={() => { setRows(null); setFilter(key) }}>{label}</button>
          ))}
        </div>
      </div>
      {!rows ? <PageSkeleton variant="list" padded={false} /> : (
        <div className="card">
          {rows.length === 0 ? (
            <Empty icon={CreditCard} title={filter === 'pending' ? 'No requests are waiting' : 'No requests'}>
              When a workspace asks for a plan, it appears here for you to activate after their transfer arrives.
            </Empty>
          ) : rows.map((r) => (
            <div className="list-row" key={r.id} style={{ cursor: 'default', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <span className="grow" style={{ minWidth: 220 }}>
                <div>
                  <button className="link-btn" onClick={() => onOpen(r.org_id)}>{r.org_name}</button>{' '}
                  <span className="muted">wants</span> <b>{r.plan_name}</b>{r.addons?.length > 0 && <span className="muted"> + {r.addons.join(', ').replaceAll('_', ' ')}</span>} <span className="muted">· {seatsText(r.seats)} · {r.period}</span>
                </div>
                <div className="small muted" style={{ marginTop: 2 }}>
                  Now on {r.current_plan || 'no plan'}{r.org_status ? ` (${r.org_status})` : ''} · asked {timeAgo(r.created_at)} by {r.requested_by}
                </div>
                <div className="small" style={{ marginTop: 2 }}>
                  Transfer reference: {r.payment_reference ? <b className="mono">{r.payment_reference}</b> : <span className="muted">none given yet</span>}
                </div>
                {r.discount_note && <div className="small" style={{ marginTop: 2, color: '#16a34a' }}>Discount: {r.discount_note} (list {money(r.list_amount ?? r.amount, r.currency)})</div>}
                {r.note && <div className="muted small" style={{ marginTop: 2 }}>“{r.note}”</div>}
                {r.decision_note && <div className="muted small" style={{ marginTop: 2 }}>Your note: “{r.decision_note}”</div>}
              </span>
              <b style={{ fontSize: 16 }}>{money(r.amount, r.currency)}</b>
              {r.status === 'pending' ? (
                <span className="row" style={{ gap: 6 }}>
                  <button className="btn btn-sm" onClick={() => setDeciding({ request: r, approve: false })}><X size={14} /> Reject</button>
                  <button className="btn btn-primary btn-sm" onClick={() => setDeciding({ request: r, approve: true })}><Check size={14} /> Activate</button>
                </span>
              ) : <RequestBadge status={r.status} />}
            </div>
          ))}
        </div>
      )}
      {deciding && <DecisionModal {...deciding} onClose={() => setDeciding(null)} onDone={() => { setDeciding(null); load(); onChanged() }} />}
    </>
  )
}

/* ───────────── Plans ───────────── */

const EMPTY_PLAN = { name: '', description: '', price_monthly: 0, price_yearly: 0, max_users: '', max_projects: '', features: [], is_public: true, sort: 5 }

function PlanModal({ plan, currency, onClose, onSaved }) {
  const toast = useToast()
  const [form, setForm] = useState(plan ? { ...plan, max_users: plan.max_users ?? '', max_projects: plan.max_projects ?? '' } : EMPTY_PLAN)
  const [busy, setBusy] = useState(false)
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })
  const toggle = (key) => setForm({ ...form, features: form.features.includes(key) ? form.features.filter((f) => f !== key) : [...form.features, key] })
  const isTrial = plan?.key === 'trial'
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const body = {
        name: form.name, description: form.description, price_monthly: Number(form.price_monthly) || 0, price_yearly: Number(form.price_yearly) || 0,
        max_users: form.max_users === '' ? null : Number(form.max_users), max_projects: form.max_projects === '' ? null : Number(form.max_projects),
        features: form.features, is_public: form.is_public, sort: Number(form.sort) || 0,
      }
      await api(plan ? `/platform/plans/${plan.id}` : '/platform/plans', { method: plan ? 'PUT' : 'POST', body })
      toast(plan ? 'Plan updated' : 'Plan created')
      onSaved()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }
  return (
    <Modal title={plan ? `Edit ${plan.name}` : 'New plan'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body stack">
          <div className="form-grid">
            <Field label="Name"><input className="input" value={form.name} onChange={set('name')} maxLength={60} required autoFocus /></Field>
            <Field label="Order in the list"><input className="input" type="number" min="0" max="1000" value={form.sort} onChange={set('sort')} /></Field>
          </div>
          <Field label="Description"><input className="input" value={form.description} onChange={set('description')} maxLength={300} /></Field>
          {!isTrial && (
            <div className="form-grid">
              <Field label={`Price per user / month (${currency})`}><input className="input" type="number" min="0" step="any" value={form.price_monthly} onChange={set('price_monthly')} required /></Field>
              <Field label={`Price per user / year (${currency})`}><input className="input" type="number" min="0" step="any" value={form.price_yearly} onChange={set('price_yearly')} required /></Field>
            </div>
          )}
          <div className="form-grid">
            <Field label="Maximum users" hint="Leave empty for unlimited."><input className="input" type="number" min="1" value={form.max_users} onChange={set('max_users')} placeholder="Unlimited" /></Field>
            <Field label="Maximum projects" hint="Leave empty for unlimited."><input className="input" type="number" min="1" value={form.max_projects} onChange={set('max_projects')} placeholder="Unlimited" /></Field>
          </div>
          <Field label="Included features" as="div">
            <div className="feature-checks">
              {Object.entries(FEATURE_LABELS).map(([key, label]) => (
                <label className="opt-row" key={key}><input type="checkbox" checked={form.features.includes(key)} onChange={() => toggle(key)} /> {label}</label>
              ))}
            </div>
            <span className="hint">Projects, issues, boards, Gantt, documents and personal chat are part of every plan.</span>
          </Field>
          {isTrial
            ? <div className="callout"><Info size={16} /><span>New workspaces start on this plan automatically. It is never shown for sale.</span></div>
            : <label className="opt-row"><input type="checkbox" checked={form.is_public} onChange={(e) => setForm({ ...form, is_public: e.target.checked })} /> On sale (shown on the sign-up and Billing pages)</label>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Save plan'}</button>
        </div>
      </form>
    </Modal>
  )
}

function Plans({ plans, currency, reload }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [editing, setEditing] = useState(null)
  const remove = async (plan) => {
    if (!(await confirm({ title: `Delete the ${plan.name} plan?`, message: 'Workspaces cannot request it any more.', confirmLabel: 'Delete plan', danger: true }))) return
    try {
      await api(`/platform/plans/${plan.id}`, { method: 'DELETE' })
      toast('Plan deleted')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  if (!plans) return <PageSkeleton variant="list" padded={false} />
  return (
    <>
      <div className="toolbar">
        <span className="muted small grow">Prices are per user. Changing a plan affects every workspace on it straight away; prices only affect new requests.</span>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> New plan</button>
      </div>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>Plan</th><th>Per user / month</th><th>Per user / year</th><th>Users</th><th>Projects</th><th>Features</th><th>Workspaces</th><th /></tr></thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b> {!p.is_public && <Badge color="#94a3b8" dot={false}>{p.key === 'trial' ? 'Automatic' : 'Hidden'}</Badge>}<div className="faint small">{p.description}</div></td>
                <td>{p.key === 'trial' || !p.price_monthly ? 'Free' : money(p.price_monthly, currency)}</td>
                <td>{p.key === 'trial' || !p.price_yearly ? 'Free' : money(p.price_yearly, currency)}</td>
                <td>{p.max_users ?? 'Unlimited'}</td>
                <td>{p.max_projects ?? 'Unlimited'}</td>
                <td className="small muted">{p.features.length === Object.keys(FEATURE_LABELS).length ? 'Everything' : `${p.features.length} of ${Object.keys(FEATURE_LABELS).length}`}</td>
                <td>{p.workspaces}</td>
                <td>
                  <span className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                    <button className="btn btn-ghost btn-sm btn-icon" title="Edit" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}><Pencil size={14} /></button>
                    {!['trial', 'enterprise'].includes(p.key) && <button className="btn btn-ghost btn-sm btn-icon danger-text" title="Delete" aria-label={`Delete ${p.name}`} onClick={() => remove(p)}><Trash2 size={14} /></button>}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <PlanModal plan={editing === 'new' ? null : editing} currency={currency} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload() }} />}
    </>
  )
}

/* ───────────── Add-ons ───────────── */

const EMPTY_ADDON = { name: '', description: '', price_monthly: 0, price_yearly: 0, features: [], is_public: true, sort: 10 }

function AddonModal({ addon, currency, onClose, onSaved }) {
  const toast = useToast()
  const [form, setForm] = useState(addon || EMPTY_ADDON)
  const [busy, setBusy] = useState(false)
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })
  const toggle = (key) => setForm({ ...form, features: form.features.includes(key) ? form.features.filter((f) => f !== key) : [...form.features, key] })
  const submit = async (e) => {
    e.preventDefault()
    if (!form.features.length) return toast('Choose at least one feature this add-on unlocks', 'error')
    setBusy(true)
    try {
      const body = {
        name: form.name, description: form.description, price_monthly: Number(form.price_monthly) || 0, price_yearly: Number(form.price_yearly) || 0,
        features: form.features, is_public: form.is_public, sort: Number(form.sort) || 0,
      }
      await api(addon ? `/platform/addons/${addon.id}` : '/platform/addons', { method: addon ? 'PUT' : 'POST', body })
      toast(addon ? 'Add-on updated' : 'Add-on created')
      onSaved()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }
  return (
    <Modal title={addon ? `Edit ${addon.name}` : 'New add-on'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body stack">
          <div className="form-grid">
            <Field label="Name"><input className="input" value={form.name} onChange={set('name')} maxLength={60} required autoFocus /></Field>
            <Field label="Order in the list"><input className="input" type="number" min="0" max="1000" value={form.sort} onChange={set('sort')} /></Field>
          </div>
          <Field label="Description"><input className="input" value={form.description} onChange={set('description')} maxLength={300} /></Field>
          <div className="form-grid">
            <Field label={`Price per user / month (${currency})`}><input className="input" type="number" min="0" step="any" value={form.price_monthly} onChange={set('price_monthly')} required /></Field>
            <Field label={`Price per user / year (${currency})`}><input className="input" type="number" min="0" step="any" value={form.price_yearly} onChange={set('price_yearly')} required /></Field>
          </div>
          <Field label="Unlocks" as="div">
            <div className="feature-checks">
              {Object.entries(FEATURE_LABELS).map(([key, label]) => (
                <label className="opt-row" key={key}><input type="checkbox" checked={form.features.includes(key)} onChange={() => toggle(key)} /> {label}</label>
              ))}
            </div>
            <span className="hint">A workspace whose plan already includes all of these is never charged for the add-on.</span>
          </Field>
          <label className="opt-row"><input type="checkbox" checked={form.is_public} onChange={(e) => setForm({ ...form, is_public: e.target.checked })} /> On sale (shown on the Billing page)</label>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Save add-on'}</button>
        </div>
      </form>
    </Modal>
  )
}

function Addons({ addons, currency, reload }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [editing, setEditing] = useState(null)
  const remove = async (addon) => {
    if (!(await confirm({ title: `Delete the ${addon.name} add-on?`, message: 'Workspaces cannot buy it any more.', confirmLabel: 'Delete add-on', danger: true }))) return
    try {
      await api(`/platform/addons/${addon.id}`, { method: 'DELETE' })
      toast('Add-on deleted')
      reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  if (!addons) return <PageSkeleton variant="list" padded={false} />
  return (
    <>
      <div className="toolbar">
        <span className="muted small grow">Extras a workspace can buy on top of any plan, priced per user. Give one free from the workspace's own page.</span>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> New add-on</button>
      </div>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>Add-on</th><th>Per user / month</th><th>Per user / year</th><th>Unlocks</th><th>Workspaces</th><th /></tr></thead>
          <tbody>
            {addons.map((a) => (
              <tr key={a.id}>
                <td><b>{a.name}</b> {!a.is_public && <Badge color="#94a3b8" dot={false}>Hidden</Badge>}<div className="faint small">{a.description}</div></td>
                <td>{money(a.price_monthly, currency)}</td>
                <td>{money(a.price_yearly, currency)}</td>
                <td className="small muted">{a.features.map((f) => FEATURE_LABELS[f] || f).join(', ')}</td>
                <td>{a.workspaces}</td>
                <td>
                  <span className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                    <button className="btn btn-ghost btn-sm btn-icon" title="Edit" aria-label={`Edit ${a.name}`} onClick={() => setEditing(a)}><Pencil size={14} /></button>
                    <button className="btn btn-ghost btn-sm btn-icon danger-text" title="Delete" aria-label={`Delete ${a.name}`} onClick={() => remove(a)}><Trash2 size={14} /></button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <AddonModal addon={editing === 'new' ? null : editing} currency={currency} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload() }} />}
    </>
  )
}

/* ───────────── Invoices and settings ───────────── */

function Invoices({ onInvoice }) {
  const [rows, setRows] = useState(null)
  useEffect(() => { api('/platform/invoices').then(setRows).catch(() => setRows([])) }, [])
  if (!rows) return <PageSkeleton variant="list" padded={false} />
  return (
    <div className="card table-wrap">
      <table className="table">
        <thead><tr><th>Number</th><th>Workspace</th><th>Plan</th><th>Period</th><th>Reference</th><th>Amount</th><th>Issued</th></tr></thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.id} className="clickable" onClick={() => onInvoice(i.id)}>
              <td><b>{i.number}</b></td>
              <td>{i.org_name}</td>
              <td>{i.plan_name}<span className="faint small"> · {seatsText(i.seats)}</span></td>
              <td className="small muted">{formatDate(i.period_start, true)} – {formatDate(i.period_end, true)}</td>
              <td className="mono small">{i.payment_reference || '—'}</td>
              <td><b>{money(i.amount, i.currency)}</b></td>
              <td className="muted small">{formatDate(i.issued_at, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <Empty icon={FileText} title="No invoices yet">One is issued each time you activate a license.</Empty>}
    </div>
  )
}

/** Shown while the currency is being changed: the exchange rate, and what every price becomes. */
function CurrencyChange({ from, to, onChange }) {
  const [rate, setRate] = useState('')
  const [friendly, setFriendly] = useState(true)
  const [preview, setPreview] = useState(null)
  useEffect(() => {
    api(`/platform/currency/rate?to=${to}`).then((r) => setRate(r.rate ? String(r.rate) : '')).catch(() => {})
  }, [to])
  useEffect(() => {
    onChange({ rate: Number(rate), friendly })
    if (!(Number(rate) > 0)) return setPreview(null)
    const timer = setTimeout(() => {
      api('/platform/currency', { method: 'POST', body: { currency: to, rate: Number(rate), friendly, preview: true } })
        .then((r) => setPreview(r.rows)).catch(() => setPreview(null))
    }, 300)
    return () => clearTimeout(timer)
  }, [rate, friendly, to]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="currency-change stack" style={{ gap: 10 }}>
      <div><b>Changing the currency from {from} to {to}</b>
        <div className="small muted">Prices are converted too, so a {from} price does not simply become the same number in {to}. Requests and invoices already sent keep their own currency.</div>
      </div>
      <div className="row row-wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
        <Field label={`1 ${from} =`}>
          <span className="row" style={{ gap: 6 }}><input className="input" type="number" min="0" step="any" style={{ maxWidth: 140 }} value={rate} onChange={(e) => setRate(e.target.value)} required aria-label="Exchange rate" /> {to}</span>
        </Field>
        <label className="opt-row" style={{ marginBottom: 8 }}><input type="checkbox" checked={friendly} onChange={(e) => setFriendly(e.target.checked)} /> Round to friendly prices (for example 499 and 999)</label>
      </div>
      <span className="hint">The suggested rate is approximate; check today's rate.</span>
      {preview && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Price</th><th>Per user / month now</th><th>Becomes</th><th>Per user / year</th></tr></thead>
            <tbody>
              {preview.filter((r) => r.old_monthly > 0).map((r) => (
                <tr key={`${r.kind}${r.name}`}>
                  <td>{r.name} <span className="faint small">{r.kind}</span></td>
                  <td className="muted">{money(r.old_monthly, from)}</td>
                  <td><b>{money(r.monthly, to)}</b></td>
                  <td>{r.yearly != null ? money(r.yearly, to) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Settings() {
  const toast = useToast()
  const [form, setForm] = useState(null)
  const [saved, setSaved] = useState('')
  const [conversion, setConversion] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { api('/platform/settings').then((f) => { setForm(f); setSaved(f.currency) }).catch((e) => toast(e.message, 'error')) }, [toast])
  if (!form) return <Spinner page />
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })
  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const currency = form.currency.toUpperCase()
      if (currency !== saved) {
        if (!(conversion?.rate > 0)) throw new Error('Enter the exchange rate for the new currency')
        await api('/platform/currency', { method: 'POST', body: { currency, rate: conversion.rate, friendly: conversion.friendly } })
      }
      const next = await api('/platform/settings', { method: 'PUT', body: { ...form, currency, trial_days: Number(form.trial_days) } })
      setForm(next)
      setSaved(next.currency)
      toast(currency !== saved ? `Settings saved. Prices are now in ${currency}.` : 'Settings saved')
    } catch (err) {
      toast(err.message, 'error')
    }
    setBusy(false)
  }
  return (
    <form className="card card-pad stack settings-section" style={{ maxWidth: 820 }} onSubmit={save}>
      <div className="form-grid">
        <Field label="Your company name" hint="Shown on invoices and the sign-up page."><input className="input" value={form.company_name} onChange={set('company_name')} required /></Field>
        <Field label="Support email"><input className="input" type="email" value={form.support_email} onChange={set('support_email')} /></Field>
        <Field label="Currency" hint="Three-letter code, for example USD, EUR or INR."><input className="input" value={form.currency} onChange={set('currency')} pattern="[A-Za-z]{3}" maxLength={3} required /></Field>
        <Field label="Free trial length (days)"><input className="input" type="number" min="1" max="365" value={form.trial_days} onChange={set('trial_days')} required /></Field>
      </div>
      {/^[A-Za-z]{3}$/.test(form.currency) && form.currency.toUpperCase() !== saved && (
        <CurrencyChange key={form.currency.toUpperCase()} from={saved} to={form.currency.toUpperCase()} onChange={setConversion} />
      )}
      <label className="opt-row"><input type="checkbox" checked={form.allow_signup} onChange={(e) => setForm({ ...form, allow_signup: e.target.checked })} /> Anyone can sign up for a workspace (turn off to create workspaces yourself)</label>
      <Field label="Payment instructions" hint="Shown to workspaces when they request a plan. Put your company's bank details here.">
        <textarea className="textarea" rows={7} value={form.payment_instructions} onChange={set('payment_instructions')} maxLength={5000} />
      </Field>
      <Field label="Headline on the public home page"><input className="input" value={form.tagline || ''} onChange={set('tagline')} maxLength={200} /></Field>
      <Field label="Terms of service" hint="Shown at /terms. New customers must accept them when they sign up. Have them checked by a lawyer.">
        <textarea className="textarea" rows={8} value={form.terms_text || ''} onChange={set('terms_text')} maxLength={50000} />
      </Field>
      <Field label="Privacy policy" hint="Shown at /privacy.">
        <textarea className="textarea" rows={8} value={form.privacy_text || ''} onChange={set('privacy_text')} maxLength={50000} />
      </Field>
      <div><button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Save settings'}</button></div>
    </form>
  )
}

/* ───────────── Page ───────────── */

export default function Platform() {
  const [params, setParams] = useSearchParams()
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'overview'
  const [plans, setPlans] = useState(null)
  const [addons, setAddons] = useState(null)
  const [currency, setCurrency] = useState('USD')
  const [pending, setPending] = useState(0)
  const [tickets, setTickets] = useState(0)
  const [openOrg, setOpenOrg] = useState(null)
  const [invoiceId, setInvoiceId] = useState(null)
  const [version, setVersion] = useState(0)

  const reload = useCallback(() => {
    api('/platform/plans').then((r) => setPlans(r.plans)).catch(() => setPlans([]))
    api('/platform/addons').then((r) => setAddons(r.addons)).catch(() => setAddons([]))
    api('/platform/overview').then((r) => { setPending(r.pending_requests); setCurrency(r.currency) }).catch(() => {})
    api('/platform/support?status=open').then((r) => setTickets(r.open)).catch(() => {})
    setVersion((v) => v + 1)
    notifyChanged()
  }, [])
  useEffect(() => { reload() }, [reload])

  const goTo = (key) => setParams(key === 'overview' ? {} : { tab: key })

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Owner console</h1>
          <p>Every workspace that uses your product: licenses, payments and plans.</p>
        </div>
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => goTo(t.key)}>
            {t.label}
            {t.key === 'requests' && pending > 0 && <span className="pill alert">{pending}</span>}
            {t.key === 'support' && tickets > 0 && <span className="pill alert">{tickets}</span>}
          </button>
        ))}
      </div>
      {tab === 'overview' && <Overview key={version} onOpen={setOpenOrg} goTo={goTo} />}
      {tab === 'workspaces' && <Workspaces onOpen={setOpenOrg} version={version} onChanged={reload} />}
      {tab === 'requests' && <Requests onOpen={setOpenOrg} onChanged={reload} />}
      {tab === 'plans' && <Plans plans={plans} currency={currency} reload={reload} />}
      {tab === 'addons' && <Addons addons={addons} currency={currency} reload={reload} />}
      {tab === 'invoices' && <Invoices key={version} onInvoice={setInvoiceId} />}
      {tab === 'settings' && <Settings />}
      {tab === 'coupons' && <Coupons currency={currency} />}
      {tab === 'analytics' && <Analytics onOpen={setOpenOrg} />}
      {tab === 'support' && <SupportInbox onChanged={reload} />}
      {tab === 'announcements' && <Announcements />}
      {tab === 'status' && <StatusAdmin />}

      {openOrg && plans && <WorkspaceModal orgId={openOrg} plans={plans} addons={addons} onClose={() => setOpenOrg(null)} onChanged={reload} onInvoice={setInvoiceId} />}
      {invoiceId && <InvoiceModal invoiceId={invoiceId} onClose={() => setInvoiceId(null)} />}
    </div>
  )
}
