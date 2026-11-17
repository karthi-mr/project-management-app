import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, AtSign, Building2, Check, Mail, Eye, EyeOff, KeyRound, Lock, ShieldCheck, User } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../context'
import { Field, PasswordRules, Spinner, passwordValid } from '../ui'
import ThemeToggle from '../components/ThemeToggle'
import { useT } from '../i18n'

function AuthShell({ children, brand }) {
  useT()
  return (
    <div className="auth-page">
      <div className="auth-theme">
        <ThemeToggle />
      </div>
      <div className="auth-card">
        <Link to="/welcome" className="brand">
          {brand?.logo_url ? <img src={brand.logo_url} alt="" className="brand-logo" /> : (
            <span className="brand-mark">
              <Check size={18} strokeWidth={3} />
            </span>
          )}
          {brand?.name || 'Trackly'}
        </Link>
        {children}
      </div>
    </div>
  )
}

export function PasswordInput({ value, onChange, placeholder, autoFocus, autoComplete = 'current-password' }) {
  const [show, setShow] = useState(false)
  return (
    <div className="input-icon">
      <Lock size={15} />
      <input
        className="input"
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        required
      />
      <button
        type="button"
        className="btn btn-icon btn-sm btn-ghost reveal"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
      >
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  )
}

export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const t = useT()
  const { slug } = useParams()
  const [brand, setBrand] = useState(null)
  // A workspace's own sign-in address (/w/acme) shows its name, logo and colour.
  useEffect(() => {
    if (!slug) return
    api(`/public/workspace/${slug}`).then((b) => {
      setBrand(b)
      if (b.brand_color) document.documentElement.style.setProperty('--accent', b.brand_color)
    }).catch(() => {})
  }, [slug])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const user = await login(username, password)
      navigate(user.must_change_password ? '/change-password' : location.state?.from || '/', { replace: true })
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <AuthShell brand={brand}>
      <div>
        <h1>{brand ? `Sign in to ${brand.name}` : t('auth.welcome')}</h1>
        <p className="muted">{t('auth.welcomeSub')}</p>
      </div>
      <form onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        <Field label={t('auth.username')}>
          <div className="input-icon">
            <User size={15} />
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="you@company.com"
              autoComplete="username"
              autoFocus
              required
            />
          </div>
        </Field>
        <Field label={t('auth.password')}>
          <PasswordInput value={password} onChange={setPassword} placeholder="••••••••" />
        </Field>
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? <Spinner /> : t('auth.signIn')}
        </button>
      </form>
      <div className="auth-foot">
        <Link to="/forgot-password">{t('auth.forgot')}</Link>
      </div>
      <div className="auth-foot" style={{ marginTop: -8 }}>
        <span className="muted">{t('auth.new')}</span> <Link to="/signup">{t('auth.create')}</Link>
      </div>
    </AuthShell>
  )
}

export function Signup() {
  const { setSession } = useAuth()
  const navigate = useNavigate()
  const t = useT()
  const [form, setForm] = useState({ company: '', full_name: '', email: '', username: '', password: '', website: '', accept_terms: false })
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  useEffect(() => {
    api('/public/plans').then((r) => setInfo(r.settings)).catch(() => setInfo({ allow_signup: true, trial_days: 14 }))
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!passwordValid(form.password)) return setError('Choose a password that meets the rules below.')
    setBusy(true)
    try {
      setSession(await api('/auth/register', { method: 'POST', body: form }))
      navigate('/', { replace: true })
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  if (info && !info.allow_signup) {
    return (
      <AuthShell>
        <div>
          <h1>Sign-up is closed</h1>
          <p className="muted">New workspaces are set up by our team.{info.support_email ? ` Write to ${info.support_email} to get one.` : ''}</p>
        </div>
        <div className="auth-foot"><Link to="/login"><ArrowLeft size={14} /> Back to sign in</Link></div>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <div>
        <h1>{t('auth.createTitle')}</h1>
        <p className="muted">
          {info ? `Free for ${info.trial_days} days with every feature. ` : ''}No payment details needed.
        </p>
      </div>
      <form onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        <Field label={t('auth.company')}>
          <div className="input-icon"><Building2 size={15} /><input className="input" value={form.company} onChange={set('company')} minLength={2} maxLength={120} autoComplete="organization" autoFocus required /></div>
        </Field>
        <Field label={t('auth.yourName')}>
          <div className="input-icon"><User size={15} /><input className="input" value={form.full_name} onChange={set('full_name')} maxLength={120} autoComplete="name" required /></div>
        </Field>
        <Field label={t('auth.email')}>
          <div className="input-icon"><Mail size={15} /><input className="input" type="email" value={form.email} onChange={set('email')} autoComplete="email" required /></div>
        </Field>
        <Field label={t('auth.usernameOnly')} hint="Letters, numbers, dots, dashes and underscores.">
          <div className="input-icon"><AtSign size={15} /><input className="input" value={form.username} onChange={set('username')} minLength={3} maxLength={50} autoComplete="username" required /></div>
        </Field>
        <Field label={t('auth.password')} as="div">
          <PasswordInput value={form.password} onChange={(password) => setForm({ ...form, password })} autoComplete="new-password" />
          <PasswordRules password={form.password} />
        </Field>
        <input className="hp-field" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={set('website')} name="website" />
        <label className="opt-row" style={{ alignItems: 'flex-start' }}>
          <input type="checkbox" checked={form.accept_terms} onChange={(e) => setForm({ ...form, accept_terms: e.target.checked })} required style={{ marginTop: 2 }} />
          <span>{t('auth.agree')} <Link to="/terms" target="_blank">{t('auth.terms')}</Link> {t('auth.and')} <Link to="/privacy" target="_blank">{t('auth.privacy')}</Link></span>
        </label>
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? <Spinner /> : t('auth.start')}
        </button>
      </form>
      <div className="auth-foot">
        <span className="muted">{t('auth.have')}</span> <Link to="/login">{t('auth.signIn')}</Link>
      </div>
    </AuthShell>
  )
}

export function ForgotPassword() {
  const [identifier, setIdentifier] = useState('')
  const [note, setNote] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const res = await api('/auth/forgot-password', { method: 'POST', body: { identifier, note } })
      setMessage(res.message)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell>
      <div>
        <h1>Reset your password</h1>
        <p className="muted">
          Tell us who you are and your administrator will issue a temporary password. You will choose a new
          one the next time you sign in.
        </p>
      </div>
      {message ? (
        <div className="form-success">
          <b>Request sent.</b> {message}
        </div>
      ) : (
        <form onSubmit={submit}>
          {error && <div className="form-error">{error}</div>}
          <Field label="Username or email">
            <div className="input-icon">
              <User size={15} />
              <input
                className="input"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </div>
          </Field>
          <Field label="Message to administrator (optional)">
            <textarea
              className="textarea"
              style={{ minHeight: 70 }}
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Lost access to my password manager"
            />
          </Field>
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? <Spinner /> : 'Request password reset'}
          </button>
        </form>
      )}
      <div className="auth-foot">
        <Link to="/login" className="row" style={{ justifyContent: 'center', gap: 6 }}>
          <ArrowLeft size={14} /> Back to sign in
        </Link>
      </div>
    </AuthShell>
  )
}

export function ChangePassword() {
  const { user, loading, setSession, logout } = useAuth()
  const navigate = useNavigate()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (loading) return <Spinner page />
  if (!user) return <Navigate to="/login" replace />
  if (!user.must_change_password) return <Navigate to="/profile" replace />

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (next !== confirm) return setError('The new passwords do not match.')
    setBusy(true)
    try {
      const session = await api('/auth/change-password', {
        method: 'POST',
        body: { current_password: current, new_password: next },
      })
      setSession(session)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <AuthShell>
      <div>
        <h1>Choose a new password</h1>
        <p className="muted">
          Hi {user.full_name.split(' ')[0]} — you signed in with a temporary password. Set your own before
          continuing.
        </p>
      </div>
      <form onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        <Field label="Temporary password">
          <PasswordInput value={current} onChange={setCurrent} autoFocus />
        </Field>
        <Field label="New password">
          <PasswordInput value={next} onChange={setNext} autoComplete="new-password" />
        </Field>
        <PasswordRules password={next} />
        <Field label="Confirm new password">
          <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
        </Field>
        <button className="btn btn-primary btn-block" disabled={busy || !passwordValid(next) || !confirm}>
          {busy ? <Spinner /> : (<><ShieldCheck size={16} /> Save and continue</>)}
        </button>
      </form>
      <div className="auth-foot">
        <button className="btn btn-ghost btn-sm" onClick={logout}>
          <KeyRound size={14} /> Sign in as someone else
        </button>
      </div>
    </AuthShell>
  )
}
