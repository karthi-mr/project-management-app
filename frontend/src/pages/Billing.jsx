import { useCallback, useEffect, useState } from 'react'
import { Building2, Copy, CreditCard, Download, FileText, FolderKanban, ImagePlus, Info, KeyRound, Pencil, Trash2, Users } from 'lucide-react'
import { api, getToken, uploadImage } from '../api'
import { timeZones } from '../i18n'
import { ACCENTS } from '../ui'
import { useAuth, useConfirm, useToast } from '../context'
import { Empty, Field, Modal, PageSkeleton, Progress, Spinner, formatDate, timeAgo } from '../ui'
import { InvoiceModal, LicenseBadge, PlanFeatures, RequestBadge, money, seatsText } from '../components/License'

function Usage({ icon: Icon, label, used, limit }) {
  const percent = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row between">
        <span className="icon-label muted"><Icon size={15} /> <span>{label}</span></span>
        <b>{used} <span className="muted" style={{ fontWeight: 400 }}>of {limit ?? 'unlimited'}</span></b>
      </div>
      {limit != null && <Progress value={percent} color={percent >= 100 ? '#ef4444' : percent >= 80 ? '#f59e0b' : 'var(--accent)'} />}
    </div>
  )
}

function WorkspaceModal({ org, onClose, onSaved }) {
  const toast = useToast()
  const [name, setName] = useState(org.name)
  const [email, setEmail] = useState(org.billing_email || '')
  const [logo, setLogo] = useState(org.logo_url || '')
  const [color, setColor] = useState(org.brand_color || '')
  const [slug, setSlug] = useState(org.slug || '')
  const [zone, setZone] = useState(org.timezone || '')
  const [busy, setBusy] = useState(false)
  const pickLogo = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      setLogo(await uploadImage(file))
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api('/billing/workspace', { method: 'PATCH', body: { name, billing_email: email, logo_url: logo || null, brand_color: color || null, slug: slug.trim() || null, timezone: zone } })
      toast('Workspace updated')
      onSaved()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }
  return (
    <Modal title="Workspace and branding" onClose={onClose}>
      <form onSubmit={save}>
        <div className="modal-body stack">
          <Field label="Workspace name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} required autoFocus /></Field>
          <Field label="Billing email" hint="Shown on your invoices."><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Logo" as="div" hint="Shown in the sidebar, on your sign-in page and on client share pages.">
            <div className="row" style={{ gap: 10 }}>
              {logo ? <img src={logo} alt="" className="brand-logo lg" /> : <span className="brand-logo lg empty"><Building2 size={18} /></span>}
              <label className="btn btn-sm"><ImagePlus size={14} /> {logo ? 'Change' : 'Upload'}<input type="file" accept="image/*" hidden onChange={pickLogo} /></label>
              {logo && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLogo('')}>Remove</button>}
            </div>
          </Field>
          <Field label="Brand colour" as="div" hint="The default accent colour for everyone in the workspace. People can still pick their own in their profile.">
            <div className="swatches">
              <button type="button" className={`swatch lg none ${!color ? 'active' : ''}`} onClick={() => setColor('')} title="Trackly default" aria-label="Default colour" />
              {ACCENTS.map((a) => (
                <button key={a.key} type="button" className={`swatch lg ${color.toLowerCase() === a.key ? 'active' : ''}`} style={{ background: a.key, color: a.key }} onClick={() => setColor(a.key)} title={a.label} aria-label={a.label} />
              ))}
            </div>
          </Field>
          <div className="form-grid">
            <Field label="Your sign-in address" hint={slug.trim() ? `${window.location.origin}/w/${slug.trim().toLowerCase()}` : 'Optional. A sign-in page with your name and logo.'}>
              <input className="input" value={slug} onChange={(e) => setSlug(e.target.value)} maxLength={40} placeholder="acme" />
            </Field>
            <Field label="Workspace time zone" hint="Used for everyone who has not chosen their own.">
              <select className="select" value={zone} onChange={(e) => setZone(e.target.value)}>
                <option value="">Each person's device</option>
                {timeZones().map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </Field>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

function DeleteWorkspaceModal({ org, onClose }) {
  const { logout } = useAuth()
  const toast = useToast()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api('/billing/delete-workspace', { method: 'POST', body: { name, password } })
      toast('The workspace was deleted')
      logout()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }
  return (
    <Modal title="Delete this workspace?" onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <div className="modal-body stack">
          <div className="form-error">Everything in {org.name} is deleted for all {org.usage.users} users: {org.usage.projects} projects with their issues, documents and files. This cannot be undone. Download an export first if you may need the data.</div>
          <Field label={`Type the workspace name (${org.name}) to confirm`}><input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></Field>
          <Field label="Your password"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></Field>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" disabled={busy || name.trim() !== org.name}>{busy ? <Spinner /> : 'Delete everything'}</button>
        </div>
      </form>
    </Modal>
  )
}

/** An add-on is already covered when the plan includes everything it unlocks, or when it was given free. */
function addonState(addon, plan, org) {
  if (plan && addon.features.every((f) => plan.features.includes(f))) return 'included'
  const mine = org.addons.find((a) => a.key === addon.key)
  if (mine?.free) return 'free'
  return mine ? 'active' : 'off'
}

function RequestModal({ plan, org, settings, addons, preselect, onClose, onSent }) {
  const toast = useToast()
  const minSeats = Math.max(1, org.usage.users)
  const [period, setPeriod] = useState('yearly')
  const [seats, setSeats] = useState(Math.min(plan.max_users ?? Infinity, Math.max(minSeats, org.seats && !org.is_trial ? org.seats : minSeats)))
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [coupon, setCoupon] = useState('')
  const [quote, setQuote] = useState(null)
  const [couponError, setCouponError] = useState('')
  const [busy, setBusy] = useState(false)
  // Keep the add-ons already paid for, plus the one the person clicked on.
  const [chosen, setChosen] = useState(() => new Set([...org.addons.filter((a) => !a.free).map((a) => a.key), ...(preselect ? [preselect] : [])]))
  const buyable = addons.filter((a) => !['included', 'free'].includes(addonState(a, plan, org)))
  const picked = buyable.filter((a) => chosen.has(a.key))
  const perUser = (item) => (period === 'yearly' ? item.price_yearly : item.price_monthly)
  const price = perUser(plan) + picked.reduce((sum, a) => sum + perUser(a), 0)
  const total = price * (Number(seats) || 0)
  const pickedKeys = picked.map((a) => a.key).join(',')
  const toggle = (key) => setChosen((set) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  // The server works out discounts (your workspace's own, and any coupon).
  useEffect(() => {
    if (!Number(seats)) return undefined
    const timer = setTimeout(() => {
      api('/billing/quote', { method: 'POST', body: { plan_id: plan.id, seats: Number(seats), period, coupon_code: coupon.trim(), addons: pickedKeys ? pickedKeys.split(',') : [] } })
        .then((q) => { setQuote(q); setCouponError('') })
        .catch((err) => { setQuote(null); setCouponError(coupon.trim() ? err.message : '') })
    }, 300)
    return () => clearTimeout(timer)
  }, [plan.id, seats, period, coupon, pickedKeys])
  const saving = plan.price_monthly * 12 - plan.price_yearly

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const sent = await api('/billing/requests', { method: 'POST', body: { plan_id: plan.id, seats: Number(seats), period, payment_reference: reference, note, coupon_code: couponError ? '' : coupon.trim(), addons: picked.map((a) => a.key) } })
      toast(sent.status === 'approved' ? `You are now on ${plan.name}.` : 'Request sent. Your license is activated once the payment is confirmed.')
      onSent()
    } catch (err) {
      toast(err.message, 'error')
      setBusy(false)
    }
  }

  return (
    <Modal title={`Request ${plan.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body stack">
          <div className="form-grid">
            <Field label="Billing period" as="div">
              <div className="segmented" style={{ alignSelf: 'flex-start' }}>
                <button type="button" className={period === 'monthly' ? 'active' : ''} onClick={() => setPeriod('monthly')}>Monthly</button>
                <button type="button" className={period === 'yearly' ? 'active' : ''} onClick={() => setPeriod('yearly')}>Yearly</button>
              </div>
              {saving > 0 && <span className="hint">Yearly saves {money(saving, settings.currency)} per user.</span>}
            </Field>
            <Field label="Users" hint={`You have ${org.usage.users} active ${org.usage.users === 1 ? 'user' : 'users'}${plan.max_users != null ? `. ${plan.name} covers up to ${plan.max_users}.` : '.'}`}>
              <input className="input" type="number" min={minSeats} max={plan.max_users ?? 100000} value={seats} onChange={(e) => setSeats(e.target.value)} required />
            </Field>
          </div>
          {addons.length > 0 && (
            <div>
              <div className="section-title">Add-ons</div>
              <div className="addon-picks">
                {addons.map((a) => {
                  const state = addonState(a, plan, org)
                  const fixed = state === 'included' || state === 'free'
                  return (
                    <label key={a.key} className={`addon-pick ${fixed ? 'fixed' : ''}`}>
                      <input type="checkbox" checked={fixed || chosen.has(a.key)} disabled={fixed} onChange={() => toggle(a.key)} />
                      <span className="grow">
                        <b>{a.name}</b>
                        <span className="small muted">{a.description}</span>
                      </span>
                      <span className="small nowrap">
                        {state === 'included' ? `In ${plan.name}` : state === 'free' ? 'Free for you' : `+${money(perUser(a), settings.currency)}`}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}
          {quote?.lines?.length > 1 && (
            <div className="quote-lines">
              {quote.lines.map((line) => (
                <div className="row between" key={line.name}><span className="muted">{line.name} · {money(line.per_user, settings.currency)} × {seats}</span><span>{money(line.amount, settings.currency)}</span></div>
              ))}
            </div>
          )}
          <div className="quote">
            <span className="muted">{seatsText(seats || 0)} × {money(price, settings.currency)} per {period === 'yearly' ? 'year' : 'month'}</span>
            <b>
              {quote && quote.discount > 0 && <s className="muted" style={{ fontSize: 14, marginRight: 8 }}>{money(quote.list_amount, settings.currency)}</s>}
              {money(quote ? quote.amount : total, settings.currency)}
            </b>
          </div>
          {quote?.discount_note && <div className="small" style={{ color: '#16a34a', marginTop: -8 }}>Discount applied: {quote.discount_note}</div>}
          <Field label="Coupon code (optional)" hint={couponError ? undefined : 'Have a code? Enter it to see the new total.'}>
            <input className="input mono" value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} maxLength={40} />
            {couponError && <span className="hint danger-text">{couponError}</span>}
          </Field>
          <div>
            <div className="section-title">How to pay</div>
            <div className="pay-box">{settings.payment_instructions}</div>
          </div>
          <Field label="Transfer reference" hint="The reference or transaction number of your bank transfer. You can send the request first and pay afterwards.">
            <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} placeholder="For example UTR / transaction number" />
          </Field>
          <Field label="Note (optional)"><textarea className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></Field>
          {total > 0 && <div className="callout"><Info size={16} /><span>Nothing is charged here. We activate your license by hand once the transfer has arrived.</span></div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : total > 0 ? 'Send request' : `Switch to ${plan.name}`}</button>
        </div>
      </form>
    </Modal>
  )
}

export default function Billing() {
  const { refresh, user } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const [exporting, setExporting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const exportData = async () => {
    setExporting(true)
    try {
      const res = await fetch('/api/billing/export', { headers: { Authorization: `Bearer ${getToken()}` } })
      if (!res.ok) throw new Error('Could not create the export')
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = `trackly-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast('Export downloaded')
    } catch (err) {
      toast(err.message, 'error')
    }
    setExporting(false)
  }
  const [data, setData] = useState(null)
  const [choosing, setChoosing] = useState(null)
  const [editing, setEditing] = useState(false)
  const [invoiceId, setInvoiceId] = useState(null)

  const load = useCallback(() => {
    api('/billing').then(setData).catch((e) => toast(e.message, 'error'))
    refresh().catch(() => {})
  }, [toast, refresh])
  useEffect(() => { load() }, [load])
  // Arriving from an upgrade notice ("See add-ons"): scroll to the add-ons once they are on screen.
  useEffect(() => {
    if (!data || window.location.hash !== '#addons') return undefined
    // After the page's own scroll-to-top on arrival.
    const timer = setTimeout(() => document.getElementById('addons')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 350)
    return () => clearTimeout(timer)
  }, [data])

  if (!data) return <div className="page"><PageSkeleton /></div>
  const { org, plans, settings, requests, invoices, addons = [] } = data
  const addonName = (key) => addons.find((a) => a.key === key)?.name || key
  const pending = requests.find((r) => r.status === 'pending')
  const currentPaid = !org.is_trial && org.plan

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(org.license_key)
      toast('License key copied')
    } catch {
      toast('Could not copy the key', 'error')
    }
  }

  const cancel = async () => {
    if (!(await confirm({ title: 'Cancel this request?', message: 'You can send a new request at any time.', confirmLabel: 'Cancel request', danger: true }))) return
    try {
      await api(`/billing/requests/${pending.id}/cancel`, { method: 'POST' })
      toast('Request cancelled')
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Billing</h1>
          <p>Your workspace's plan, license and invoices.</p>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 18 }}>
        <div className="card">
          <div className="card-header">
            <h2 className="icon-label"><Building2 size={17} /> <span>{org.name}</span></h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}><Pencil size={13} /> Edit</button>
          </div>
          <div className="card-body stack" style={{ gap: 12 }}>
            <div className="row between row-wrap">
              <span style={{ fontSize: 22, fontWeight: 700 }}>{org.plan?.name || 'No plan'}</span>
              <LicenseBadge status={org.status} />
            </div>
            <div className="muted">
              {org.valid_until == null
                ? 'This license never expires.'
                : org.status === 'expired'
                  ? `Ended on ${formatDate(org.valid_until, true)}. The workspace is read-only until it is renewed.`
                  : `${org.is_trial ? 'Trial ends' : 'Valid until'} ${formatDate(org.valid_until, true)} (${org.days_left} ${org.days_left === 1 ? 'day' : 'days'} left).`}
            </div>
            {org.addons.length > 0 && (
              <div className="row row-wrap" style={{ gap: 6 }}>
                {org.addons.map((a) => <span className="tag" key={a.key}>{a.name}{a.free ? ' · free' : ''}</span>)}
              </div>
            )}
            {org.license_key && (
              <div>
                <div className="section-title">License key</div>
                <div className="secret-box" style={{ padding: '8px 12px' }}>
                  <KeyRound size={15} className="faint" />
                  <code style={{ fontSize: 14 }}>{org.license_key}</code>
                  <button className="btn btn-sm" onClick={copyKey}><Copy size={13} /> Copy</button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-header"><h2>Usage</h2></div>
          <div className="card-body stack" style={{ gap: 16 }}>
            <Usage icon={Users} label="Users" used={org.usage.users} limit={org.seats} />
            <Usage icon={FolderKanban} label="Projects" used={org.usage.projects} limit={org.max_projects} />
            <div className="small muted">Disabled users do not count. Need more room? Request more users or a larger plan below.</div>
          </div>
        </div>
      </div>

      {pending && (
        <div className="card card-pad stack" style={{ marginBottom: 18, gap: 10, borderColor: '#f59e0b' }}>
          <div className="row between row-wrap">
            <div>
              <b>{pending.plan_name}</b>{pending.addons.length > 0 && ` + ${pending.addons.map(addonName).join(', ')}`} for {seatsText(pending.seats)}, {pending.period}: <b>{money(pending.amount, pending.currency)}</b>{pending.discount_note ? <span className="muted small"> ({pending.discount_note})</span> : null}{' '}
              <RequestBadge status="pending" />
              <div className="small muted">Sent {timeAgo(pending.created_at)} by {pending.requested_by}{pending.payment_reference ? ` · reference ${pending.payment_reference}` : ' · no transfer reference yet'}</div>
            </div>
            <button className="btn btn-sm" onClick={cancel}>Cancel request</button>
          </div>
          <div className="pay-box">{settings.payment_instructions}</div>
        </div>
      )}

      <h2 style={{ marginBottom: 12 }}>Plans</h2>
      <div className="plan-grid" style={{ marginBottom: 24 }}>
        {plans.map((plan) => {
          const current = currentPaid && org.plan.id === plan.id
          return (
            <div className={`card plan-card ${current ? 'current' : ''}`} key={plan.id}>
              <div className="row between">
                <h3>{plan.name}</h3>
                {current && <span className="tag">Your plan</span>}
              </div>
              <p className="muted small" style={{ minHeight: 34 }}>{plan.description}</p>
              <div className="plan-price">
                {money(plan.price_monthly, settings.currency)} <span>per user / month</span>
              </div>
              <div className="small muted">or {money(plan.price_yearly, settings.currency)} per user / year</div>
              <button className={`btn btn-block ${current ? '' : 'btn-primary'}`} disabled={Boolean(pending) || org.status === 'suspended'} onClick={() => setChoosing({ plan })} title={pending ? 'You already have a request waiting' : undefined}>
                {current ? 'Renew or change users' : plan.price_monthly === 0 ? `Switch to ${plan.name}` : `Request ${plan.name}`}
              </button>
              <PlanFeatures plan={plan} />
            </div>
          )
        })}
      </div>
      {plans.length === 0 && <div className="card"><Empty icon={CreditCard} title="No plans are on sale right now">{settings.support_email ? `Contact ${settings.support_email}.` : 'Contact support.'}</Empty></div>}

      {addons.length > 0 && (
        <>
          <h2 id="addons" style={{ marginBottom: 4 }}>Add-ons</h2>
          <p className="muted small" style={{ marginBottom: 12 }}>
            Extras on top of any plan, priced per user. {currentPaid ? `Add one to ${org.plan.name} with a new request.` : 'Choose a plan above and pick add-ons in the same request.'}
          </p>
          <div className="addon-grid" style={{ marginBottom: 24 }}>
            {addons.map((a) => {
              const state = addonState(a, currentPaid ? org.plan : null, org)
              const covered = state !== 'off' || (!currentPaid && org.status === 'trial')
              return (
                <div className={`card addon-card ${state !== 'off' ? 'on' : ''}`} key={a.key}>
                  <div className="row between" style={{ gap: 8 }}>
                    <h3>{a.name}</h3>
                    {state === 'active' && <span className="tag">Active</span>}
                    {state === 'free' && <span className="tag">Free for you</span>}
                    {state === 'included' && <span className="tag">In your plan</span>}
                    {state === 'off' && !currentPaid && org.status === 'trial' && <span className="tag">In your trial</span>}
                  </div>
                  <p className="muted small grow">{a.description}</p>
                  <div className="row between row-wrap" style={{ gap: 8 }}>
                    <span><b>{money(a.price_monthly, settings.currency)}</b> <span className="muted small">per user / month</span></span>
                    {!covered && currentPaid && (
                      <button className="btn btn-sm btn-primary" disabled={Boolean(pending) || org.status === 'suspended'} onClick={() => setChoosing({ plan: plans.find((p) => p.id === org.plan.id) || org.plan, addon: a.key })}>
                        Add
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      <div className="grid grid-2">
        <div className="card">
          <div className="card-header"><h2>Requests</h2></div>
          {requests.length === 0 ? <Empty icon={CreditCard} title="No requests yet">Choose a plan above to request a license.</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Plan</th><th>Amount</th><th>Status</th><th>Sent</th></tr></thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      <td><b>{r.plan_name}</b><div className="faint small">{r.addons.length > 0 && `+ ${r.addons.map(addonName).join(', ')} · `}{seatsText(r.seats)} · {r.period}</div></td>
                      <td>{money(r.amount, r.currency)}</td>
                      <td><RequestBadge status={r.status} />{r.decision_note && <div className="muted small" style={{ marginTop: 3 }}>“{r.decision_note}”</div>}</td>
                      <td className="muted small">{formatDate(r.created_at, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-header"><h2>Invoices</h2></div>
          {invoices.length === 0 ? <Empty icon={FileText} title="No invoices yet">An invoice appears here each time a license is activated.</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Number</th><th>Plan</th><th>Amount</th><th>Issued</th></tr></thead>
                <tbody>
                  {invoices.map((i) => (
                    <tr key={i.id} className="clickable" onClick={() => setInvoiceId(i.id)}>
                      <td><b>{i.number}</b></td>
                      <td>{i.plan_name}<div className="faint small">{seatsText(i.seats)} · {i.period}</div></td>
                      <td>{money(i.amount, i.currency)}</td>
                      <td className="muted small">{formatDate(i.issued_at, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card card-pad stack" style={{ marginTop: 18 }}>
        <h2>Your data</h2>
        <div className="row between row-wrap">
          <span className="grow" style={{ minWidth: 220 }}>
            <b>Export everything</b>
            <div className="small muted">One file with all projects, issues, comments, documents, time and people of this workspace. Passwords are never included.</div>
          </span>
          <button className="btn" onClick={exportData} disabled={exporting}>{exporting ? <Spinner /> : <><Download size={14} /> Download export</>}</button>
        </div>
        {!user.is_platform_admin && (
          <div className="row between row-wrap danger-zone" style={{ paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <span className="grow" style={{ minWidth: 220 }}>
              <b>Delete this workspace</b>
              <div className="small muted">Permanently removes every project, file and account in it. This cannot be undone.</div>
            </span>
            <button className="btn btn-danger" onClick={() => setDeleting(true)}><Trash2 size={14} /> Delete workspace</button>
          </div>
        )}
      </div>

      {deleting && <DeleteWorkspaceModal org={org} onClose={() => setDeleting(false)} />}
      {choosing && <RequestModal plan={choosing.plan} preselect={choosing.addon} addons={addons} org={org} settings={settings} onClose={() => setChoosing(null)} onSent={() => { setChoosing(null); load() }} />}
      {editing && <WorkspaceModal org={org} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load() }} />}
      {invoiceId && <InvoiceModal invoiceId={invoiceId} onClose={() => setInvoiceId(null)} />}
    </div>
  )
}
