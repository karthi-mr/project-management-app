import { useCallback, useEffect, useState } from 'react'
import { Info, Laptop, LogOut, ShieldCheck } from 'lucide-react'
import { api } from '../api'
import { useAuth, useConfirm, useToast } from '../context'
import { Avatar, Empty, Field, Spinner, timeAgo } from '../ui'
import { UpgradeNotice } from './License'

/** Workspace administrators: password policy, allowed networks and who is signed in. */
export function SecuritySettings() {
  const { user } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const [data, setData] = useState(null)
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => api('/admin/security').then((d) => {
    setData(d)
    setForm({ password_min_length: d.password_min_length, password_require_symbol: d.password_require_symbol, password_require_mixed_case: d.password_require_mixed_case, ip_allowlist: d.ip_allowlist })
  }).catch((e) => toast(e.message, 'error')), [toast])
  useEffect(() => { load() }, [load])
  if (!data || !form) return <Spinner page />

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api('/admin/security', { method: 'PUT', body: { ...form, password_min_length: Number(form.password_min_length) } })
      toast('Security settings saved')
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
    setBusy(false)
  }
  const end = async (s) => {
    try {
      await api(`/admin/sessions/${s.id}/end`, { method: 'POST' })
      toast(`${s.user.full_name} was signed out on that device`)
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const endAll = async (person) => {
    if (!(await confirm({ title: `Sign ${person.full_name} out everywhere?`, message: 'They are signed out of every browser and device and have to sign in again.', confirmLabel: 'Sign out everywhere', danger: true }))) return
    try {
      await api(`/users/${person.id}/sign-out`, { method: 'POST' })
      toast(`${person.full_name} was signed out everywhere`)
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div className="stack" style={{ gap: 18 }}>
      <form className="card card-pad stack" onSubmit={save}>
        <h2 className="icon-label"><ShieldCheck size={17} /> <span>Password rules</span></h2>
        <p className="muted small">Applied when someone chooses a new password. Existing passwords keep working until they are changed.</p>
        <Field label="Minimum length">
          <input className="input" type="number" min="8" max="64" style={{ maxWidth: 120 }} value={form.password_min_length} onChange={(e) => setForm({ ...form, password_min_length: e.target.value })} required />
        </Field>
        <label className="opt-row"><input type="checkbox" checked={form.password_require_mixed_case} onChange={(e) => setForm({ ...form, password_require_mixed_case: e.target.checked })} /> Must contain upper and lower case letters</label>
        <label className="opt-row"><input type="checkbox" checked={form.password_require_symbol} onChange={(e) => setForm({ ...form, password_require_symbol: e.target.checked })} /> Must contain a symbol</label>

        <h2 style={{ marginTop: 8 }}>Allowed networks</h2>
        {data.ip_allowlist_available ? (
          <>
            <Field label="Only allow access from these addresses" hint={`One address or range per line, for example 203.0.113.7 or 203.0.113.0/24. Leave empty to allow access from anywhere. Your address right now: ${data.your_ip || 'unknown'}.`}>
              <textarea className="textarea mono" rows={4} value={form.ip_allowlist} onChange={(e) => setForm({ ...form, ip_allowlist: e.target.value })} placeholder="Access is allowed from anywhere" />
            </Field>
            <div className="callout"><Info size={16} /><span>The list must include your own address, so you cannot lock yourself out. If the service runs behind a proxy, ask whoever hosts it to confirm that real visitor addresses are passed on.</span></div>
          </>
        ) : <UpgradeNotice feature="security" compact />}
        <div><button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Save security settings'}</button></div>
      </form>

      <div className="card">
        <div className="card-header"><h2>Signed in now</h2><span className="muted small">{data.sessions.length} active {data.sessions.length === 1 ? 'session' : 'sessions'} in the last 12 hours</span></div>
        {data.sessions.length === 0 ? <Empty icon={Laptop} title="Nobody is signed in" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Person</th><th>Device</th><th>Address</th><th>Signed in</th><th>Last active</th><th /></tr></thead>
              <tbody>
                {data.sessions.map((s) => (
                  <tr key={s.id}>
                    <td><span className="row"><Avatar user={s.user} size={26} /><b>{s.user.full_name}</b>{s.current && <span className="tag">this device</span>}</span></td>
                    <td>{s.device}</td>
                    <td className="mono small">{s.ip || '—'}</td>
                    <td className="muted small">{timeAgo(s.created_at)}</td>
                    <td className="muted small">{timeAgo(s.last_seen_at)}</td>
                    <td>
                      {!s.current && (
                        <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                          <button className="btn btn-sm" onClick={() => end(s)}><LogOut size={13} /> Sign out</button>
                          {s.user.id !== user.id && <button className="btn btn-ghost btn-sm" onClick={() => endAll(s.user)}>Everywhere</button>}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

/** Everyone: the browsers and devices where you are signed in. */
export function MySessions() {
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const load = useCallback(() => api('/auth/sessions').then(setRows).catch(() => setRows([])), [])
  useEffect(() => { load() }, [load])
  const act = async (fn, message) => {
    try {
      await fn()
      toast(message)
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  if (!rows) return null
  const others = rows.filter((s) => !s.current)
  return (
    <div className="card card-pad stack">
      <div className="row between row-wrap">
        <div>
          <h2>Where you are signed in</h2>
          <p className="muted small">If you do not recognise a device, sign it out and change your password.</p>
        </div>
        {others.length > 0 && <button className="btn btn-sm" onClick={() => act(() => api('/auth/sessions/sign-out-others', { method: 'POST' }), 'Signed out everywhere else')}><LogOut size={13} /> Sign out everywhere else</button>}
      </div>
      {rows.map((s) => (
        <div className="share-row" key={s.id}>
          <Laptop size={18} className="faint" />
          <span className="grow">
            <b>{s.device}</b> {s.current && <span className="tag">this device</span>}
            <div className="small muted">{s.ip || 'Unknown address'} · signed in {timeAgo(s.created_at)} · active {timeAgo(s.last_seen_at)}</div>
          </span>
          {!s.current && <button className="btn btn-sm" onClick={() => act(() => api(`/auth/sessions/${s.id}`, { method: 'DELETE' }), 'Signed out on that device')}>Sign out</button>}
        </div>
      ))}
    </div>
  )
}
