import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ban, Check, Copy, Info, KeyRound, Pencil, Plus, RotateCcw, Search, ShieldCheck, Trash2, UserPlus, X } from 'lucide-react'
import { api, notifyChanged } from '../api'
import { useAuth, useConfirm, useToast } from '../context'
import { PlanGate } from '../components/License'
import { SecuritySettings } from '../components/Security'
import { formatDateTime, Avatar, Badge, Empty, Field, Modal, PasswordRules, Spinner, formatDate, passwordValid, timeAgo, PageSkeleton } from '../ui'

/* Password choice shared by "create user" and "reset password". */
function PasswordChoice({ mode, setMode, password, setPassword }) {
  return (
    <Field label="Temporary password" as="div">
      <div className="segmented" style={{ alignSelf: 'flex-start' }}>
        <button type="button" className={mode === 'generate' ? 'active' : ''} onClick={() => setMode('generate')}>Generate securely</button>
        <button type="button" className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}>Set manually</button>
      </div>
      {mode === 'manual' ? (
        <>
          <input className="input mono" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter a temporary password" autoComplete="off" />
          <PasswordRules password={password} />
        </>
      ) : (
        <span className="hint">A strong random password is created and shown to you once.</span>
      )}
    </Field>
  )
}

function CredentialsModal({ result, onClose }) {
  const toast = useToast()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.temporary_password)
      toast('Password copied to clipboard')
    } catch {
      toast('Could not copy — select the password and copy it manually', 'error')
    }
  }
  return (
    <Modal title="Share these sign-in details" onClose={onClose} size="sm">
      <div className="modal-body">
        <p className="muted">
          Give <b>{result.user.full_name}</b> the details below through a private channel.
        </p>
        <Field label="Username" as="div">
          <div className="secret-box"><code>{result.user.username}</code></div>
        </Field>
        <Field label="Temporary password" as="div">
          <div className="secret-box">
            <code>{result.temporary_password}</code>
            <button className="btn btn-sm" onClick={copy}><Copy size={14} /> Copy</button>
          </div>
        </Field>
        <div className="callout">
          <Info size={16} />
          <span>This password is shown only once. They will be required to choose a new one the first time they sign in.</span>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  )
}

function UserModal({ existing, onClose, onSaved }) {
  const [form, setForm] = useState({
    username: existing?.username || '',
    full_name: existing?.full_name || '',
    email: existing?.email || '',
    role: existing?.role || 'member',
    hourly_rate: existing?.hourly_rate ?? '',
    weekly_capacity: existing?.weekly_capacity ?? 40,
  })
  const [mode, setMode] = useState('generate')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }))
  const passwordOk = existing || mode === 'generate' || passwordValid(password)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (existing) {
        const { username, ...changes } = form
        await api(`/users/${existing.id}`, {
          method: 'PATCH',
          body: { ...changes, hourly_rate: changes.hourly_rate === '' ? null : Number(changes.hourly_rate), weekly_capacity: Number(changes.weekly_capacity) || 40 },
        })
        onSaved(null)
      } else {
        const result = await api('/users', {
          method: 'POST',
          body: { ...form, password: mode === 'manual' ? password : null },
        })
        onSaved(result)
      }
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <Modal title={existing ? `Edit ${existing.full_name}` : 'Add user'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}
          <div className="form-grid">
            <Field label="Full name">
              <input className="input" value={form.full_name} onChange={set('full_name')} maxLength={120} placeholder="Jane Doe" autoFocus required />
            </Field>
            <Field label="Username" hint={existing ? 'Usernames cannot be changed.' : 'Letters, numbers, . - _'}>
              <input
                className="input"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '') }))}
                minLength={3}
                maxLength={50}
                placeholder="jane"
                disabled={Boolean(existing)}
                autoComplete="off"
                required
              />
            </Field>
            <Field label="Email">
              <input className="input" type="email" value={form.email} onChange={set('email')} placeholder="jane@company.com" required />
            </Field>
            <Field label="Role">
              <select className="select" value={form.role} onChange={set('role')}>
                <option value="member">Member — works in projects they are added to</option>
                <option value="manager">Manager — can also create projects</option>
                <option value="admin">Administrator — manages users, sees everything</option>
              </select>
            </Field>
          </div>
          {existing && (
            <div className="form-grid">
              <Field label="Hourly rate" hint="Used to cost logged time in project budgets. Leave empty if not costed.">
                <input className="input" type="number" min="0" step="any" value={form.hourly_rate} onChange={set('hourly_rate')} placeholder="—" />
              </Field>
              <Field label="Weekly capacity (hours)" hint="Used on the Workload page">
                <input className="input" type="number" min="0" max="168" step="0.5" value={form.weekly_capacity} onChange={set('weekly_capacity')} />
              </Field>
            </div>
          )}
          {!existing && <PasswordChoice mode={mode} setMode={setMode} password={password} setPassword={setPassword} />}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !passwordOk}>
            {busy ? <Spinner /> : existing ? 'Save changes' : (<><UserPlus size={15} /> Create user</>)}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ResetPasswordModal({ target, onClose, onDone }) {
  const [mode, setMode] = useState('generate')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const result = await api(`/users/${target.id}/reset-password`, {
        method: 'POST',
        body: { password: mode === 'manual' ? password : null },
      })
      onDone(result)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <Modal title={`Reset password for ${target.full_name}`} onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}
          <p className="muted">
            Their current password stops working immediately, they are signed out everywhere, and they must
            choose a new password at next sign-in.
          </p>
          <PasswordChoice mode={mode} setMode={setMode} password={password} setPassword={setPassword} />
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || (mode === 'manual' && !passwordValid(password))}>
            {busy ? <Spinner /> : (<><KeyRound size={15} /> Reset password</>)}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export default function Users() {
  const { user: me } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()
  const [users, setUsers] = useState(null)
  const [requests, setRequests] = useState([])
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null) // null | 'new' | user
  const [resetting, setResetting] = useState(null)
  const [credentials, setCredentials] = useState(null)
  const [auditRows, setAuditRows] = useState(null)
  const [auditQuery, setAuditQuery] = useState('')

  const tab = ['requests', 'audit', 'security'].includes(params.get('tab')) ? params.get('tab') : 'users'

  useEffect(() => {
    if (tab !== 'audit' || !me.org?.features.includes('audit_log')) return
    const timer = setTimeout(() => {
      api(`/admin/audit?q=${encodeURIComponent(auditQuery)}`).then(setAuditRows).catch((err) => toast(err.message, 'error'))
    }, 200)
    return () => clearTimeout(timer)
  }, [tab, auditQuery]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([api('/users'), api('/admin/reset-requests')])
      setUsers(u)
      setRequests(r)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const refresh = () => {
    load()
    notifyChanged() // updates the sidebar badge
  }

  const act = async (fn, success) => {
    try {
      await fn()
      if (success) toast(success)
      refresh()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const toggleActive = async (u) => {
    if (u.is_active) {
      const ok = await confirm({
        title: `Disable ${u.full_name}?`,
        message: 'They will be signed out and unable to sign in until re-enabled. Their work is kept.',
        confirmLabel: 'Disable account',
        danger: true,
      })
      if (!ok) return
    }
    act(
      () => api(`/users/${u.id}`, { method: 'PATCH', body: { is_active: !u.is_active } }),
      u.is_active ? 'Account disabled' : 'Account enabled',
    )
  }

  const remove = async (u) => {
    const ok = await confirm({
      title: `Delete ${u.full_name}?`,
      message: 'The account is permanently removed. Issues they reported or were assigned stay, but lose the link to this user. Consider disabling instead.',
      confirmLabel: 'Delete user',
      danger: true,
    })
    if (ok) act(() => api(`/users/${u.id}`, { method: 'DELETE' }), 'User deleted')
  }

  if (error) return <div className="page"><div className="form-error">{error}</div></div>
  if (!users) return <PageSkeleton variant="list" />

  const pending = requests.filter((r) => r.status === 'pending')
  const term = query.trim().toLowerCase()
  const shown = users.filter(
    (u) => !term || `${u.full_name} ${u.username} ${u.email}`.toLowerCase().includes(term),
  )

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Users</h1>
          <p>Create accounts, issue temporary passwords and handle reset requests.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Plus size={16} /> Add user
        </button>
      </div>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'users'} className={`tab ${tab === 'users' ? 'active' : ''}`} onClick={() => setParams({})}>
          All users <span className="pill">{users.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'requests'} className={`tab ${tab === 'requests' ? 'active' : ''}`} onClick={() => setParams({ tab: 'requests' })}>
          Password reset requests {pending.length > 0 && <span className="pill alert">{pending.length}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'audit'} className={`tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setParams({ tab: 'audit' })}>
          Audit log
        </button>
        <button role="tab" aria-selected={tab === 'security'} className={`tab ${tab === 'security' ? 'active' : ''}`} onClick={() => setParams({ tab: 'security' })}>
          Security
        </button>
      </div>

      {tab === 'users' && (
        <>
          <div className="toolbar">
            <div className="input-icon">
              <Search size={15} />
              <input className="input search-input" placeholder="Search users…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr><th>User</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <span className="row">
                        <Avatar user={u} size={32} />
                        <span>
                          <div style={{ fontWeight: 600 }}>{u.full_name} {u.id === me.id && <span className="faint small">(you)</span>}</div>
                          <div className="faint small">@{u.username}</div>
                        </span>
                      </span>
                    </td>
                    <td className="muted">{u.email}</td>
                    <td>
                      {u.role === 'admin' ? (
                        <span className="icon-label" style={{ color: 'var(--accent-text)' }}><ShieldCheck size={15} /> <span>Administrator</span></span>
                      ) : u.role === 'manager' ? 'Manager' : 'Member'}
                    </td>
                    <td>
                      {!u.is_active ? <Badge color="#94a3b8">Disabled</Badge>
                        : u.must_change_password ? <Badge color="#f59e0b">Temporary password</Badge>
                        : <Badge color="#22c55e">Active</Badge>}
                    </td>
                    <td className="muted small">{timeAgo(u.last_login)}</td>
                    <td>
                      <span className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                        <button className="btn btn-ghost btn-sm btn-icon" title="Edit" aria-label={`Edit ${u.full_name}`} onClick={() => setEditing(u)}><Pencil size={14} /></button>
                        {u.id !== me.id && (
                          <>
                            <button className="btn btn-ghost btn-sm btn-icon" title="Reset password" aria-label={`Reset password for ${u.full_name}`} onClick={() => setResetting(u)}><KeyRound size={14} /></button>
                            <button className="btn btn-ghost btn-sm btn-icon" title={u.is_active ? 'Disable' : 'Enable'} aria-label={`${u.is_active ? 'Disable' : 'Enable'} ${u.full_name}`} onClick={() => toggleActive(u)}>
                              {u.is_active ? <Ban size={14} /> : <RotateCcw size={14} />}
                            </button>
                            <button className="btn btn-ghost btn-sm btn-icon danger-text" title="Delete" aria-label={`Delete ${u.full_name}`} onClick={() => remove(u)}><Trash2 size={14} /></button>
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length === 0 && <Empty icon={Search} title="No users match your search" />}
          </div>
        </>
      )}

      {tab === 'requests' && (
        <div className="card">
          {requests.length === 0 ? (
            <Empty icon={KeyRound} title="No reset requests">
              When someone uses “Forgot your password?” on the sign-in page, their request appears here.
            </Empty>
          ) : (
            requests.map((r) => (
              <div className="list-row" key={r.id} style={{ cursor: 'default', alignItems: 'flex-start' }}>
                <Avatar user={r.user} size={34} />
                <span className="grow">
                  <div><b>{r.user.full_name}</b> <span className="faint small">@{r.user.username} · {r.email}</span></div>
                  {r.note && <div className="muted" style={{ marginTop: 2 }}>“{r.note}”</div>}
                  <div className="faint small" style={{ marginTop: 2 }}>
                    Requested {timeAgo(r.created_at)}
                    {r.resolved_at && ` · ${r.status} ${formatDate(r.resolved_at)}`}
                  </div>
                </span>
                {r.status === 'pending' ? (
                  <span className="row">
                    <button className="btn btn-sm" onClick={() => act(() => api(`/admin/reset-requests/${r.id}/reject`, { method: 'POST' }), 'Request dismissed')}>
                      <X size={14} /> Dismiss
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={() => setResetting(r.user)}>
                      <KeyRound size={14} /> Issue new password
                    </button>
                  </span>
                ) : r.status === 'approved' ? (
                  <Badge color="#22c55e" dot={false}><Check size={12} /> Password issued</Badge>
                ) : (
                  <Badge color="#94a3b8" dot={false}>Dismissed</Badge>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'security' && <SecuritySettings />}

      {tab === 'audit' && (
        <PlanGate feature="audit_log">
          <div className="toolbar">
            <div className="input-icon">
              <Search size={15} />
              <input className="input search-input" placeholder="Search user, action or detail…" value={auditQuery} onChange={(e) => setAuditQuery(e.target.value)} />
            </div>
            <span className="small muted">Sign-ins, password changes and account administration. Latest 200 entries.</span>
          </div>
          {!auditRows ? <Spinner page /> : (
            <div className="card table-wrap">
              <table className="table">
                <thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th><th>IP address</th></tr></thead>
                <tbody>
                  {auditRows.map((a) => (
                    <tr key={a.id}>
                      <td className="muted small" style={{ whiteSpace: 'nowrap' }} title={a.created_at}>{formatDateTime(a.created_at)}</td>
                      <td><b>{a.actor || '—'}</b></td>
                      <td><Badge color={a.action.includes('failed') || a.action.includes('deleted') ? '#ef4444' : a.action.startsWith('password') ? '#f59e0b' : '#6366f1'} dot={false}>{a.action}</Badge></td>
                      <td className="muted">{a.detail}</td>
                      <td className="mono muted">{a.ip}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {auditRows.length === 0 && <Empty icon={Search} title="No audit entries match" />}
            </div>
          )}
        </PlanGate>
      )}

      {editing && (
        <UserModal
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(result) => {
            setEditing(null)
            if (result) setCredentials(result)
            else toast('User updated')
            refresh()
          }}
        />
      )}
      {resetting && (
        <ResetPasswordModal
          target={resetting}
          onClose={() => setResetting(null)}
          onDone={(result) => {
            setResetting(null)
            setCredentials(result)
            refresh()
          }}
        />
      )}
      {credentials && <CredentialsModal result={credentials} onClose={() => setCredentials(null)} />}
    </div>
  )
}
