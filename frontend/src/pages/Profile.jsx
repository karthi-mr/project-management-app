import { useRef, useState } from 'react'
import { Camera, Trash2 } from 'lucide-react'
import { api, uploadImage } from '../api'
import { useAuth, useTheme, useToast } from '../context'
import { ACCENTS, Avatar, Field, PasswordRules, Spinner, formatDate, passwordValid, roleLabel } from '../ui'
import ThemeToggle from '../components/ThemeToggle'
import { LANGUAGES, timeZones } from '../i18n'
import { MySessions } from '../components/Security'
import { TwoFactorCard } from '../components/TwoFactor'
import { PasswordInput } from './AuthPages'

export default function Profile() {
  const { user, setUser, setSession } = useAuth()
  const toast = useToast()
  const { accent, setAccent, density, setDensity } = useTheme()
  const photoInput = useRef(null)
  const [photoBusy, setPhotoBusy] = useState(false)

  const changePhoto = async (file) => {
    if (!file) return
    setPhotoBusy(true)
    try {
      const url = await uploadImage(file)
      setUser(await api('/auth/avatar', { method: 'PUT', body: { url } }))
      toast('Profile photo updated')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setPhotoBusy(false)
    }
  }

  const removePhoto = async () => {
    try {
      setUser(await api('/auth/avatar', { method: 'PUT', body: { url: null } }))
      toast('Profile photo removed')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const savePref = async (change) => {
    try {
      setUser(await api('/auth/preferences', { method: 'PUT', body: { preferences: { ...(user.preferences || {}), ...change } } }))
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const [profile, setProfile] = useState({ full_name: user.full_name, email: user.email })
  const [savingProfile, setSavingProfile] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwError, setPwError] = useState('')
  const [savingPw, setSavingPw] = useState(false)

  const saveProfile = async (e) => {
    e.preventDefault()
    setSavingProfile(true)
    try {
      setUser(await api('/auth/profile', { method: 'PATCH', body: profile }))
      toast('Profile updated')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setSavingProfile(false)
    }
  }

  const changePassword = async (e) => {
    e.preventDefault()
    setPwError('')
    if (next !== confirm) return setPwError('The new passwords do not match.')
    setSavingPw(true)
    try {
      setSession(await api('/auth/change-password', { method: 'POST', body: { current_password: current, new_password: next } }))
      setCurrent('')
      setNext('')
      setConfirm('')
      toast('Password changed. Other sessions were signed out.')
    } catch (err) {
      setPwError(err.message)
    } finally {
      setSavingPw(false)
    }
  }

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="page-header">
        <div className="row" style={{ gap: 16 }}>
          <Avatar user={user} size={56} />
          <div>
            <h1>{user.full_name}</h1>
            <p>@{user.username} · {roleLabel(user.role)} · Joined {formatDate(user.created_at, true)}</p>
          </div>
        </div>
      </div>

      <div className="stack" style={{ gap: 16 }}>
        <form className="card card-pad stack" onSubmit={saveProfile}>
          <h2>Profile</h2>
          <div className="photo-edit">
            <Avatar user={user} size={72} />
            <div className="stack" style={{ gap: 8 }}>
              <div className="row row-wrap">
                <button type="button" className="btn" onClick={() => photoInput.current?.click()} disabled={photoBusy}>
                  {photoBusy ? <Spinner /> : <Camera size={15} />} {user.avatar_url ? 'Change photo' : 'Upload photo'}
                </button>
                {user.avatar_url && <button type="button" className="btn btn-ghost danger-text" onClick={removePhoto}><Trash2 size={14} /> Remove</button>}
              </div>
              <span className="hint">PNG, JPEG, GIF or WebP, up to 5 MB. A square image works best.</span>
            </div>
            <input ref={photoInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { changePhoto(e.target.files[0]); e.target.value = '' }} />
          </div>
          <div className="form-grid">
            <Field label="Full name">
              <input className="input" value={profile.full_name} maxLength={120} onChange={(e) => setProfile({ ...profile, full_name: e.target.value })} required />
            </Field>
            <Field label="Email">
              <input className="input" type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} required />
            </Field>
          </div>
          <div><button className="btn btn-primary" disabled={savingProfile}>{savingProfile ? <Spinner /> : 'Save profile'}</button></div>
        </form>

        <div className="card card-pad stack">
          <div>
            <h2>Appearance</h2>
            <p className="muted small">“System” follows your device's light or dark setting automatically.</p>
          </div>
          <Field label="Theme" as="div"><ThemeToggle labels /></Field>
          <Field label="Accent colour" as="div">
            <div className="swatches">
              {ACCENTS.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  className={`swatch lg ${accent.toLowerCase() === a.key ? 'active' : ''}`}
                  style={{ background: a.key, color: a.key }}
                  onClick={() => setAccent(a.key)}
                  title={a.label}
                  aria-label={`${a.label} accent`}
                  aria-pressed={accent.toLowerCase() === a.key}
                />
              ))}
            </div>
          </Field>
          <Field label="Density" as="div" hint="Compact fits more on screen; comfortable gives everything more room.">
            <div className="segmented" style={{ alignSelf: 'flex-start' }}>
              <button type="button" className={density === 'comfortable' ? 'active' : ''} onClick={() => setDensity('comfortable')}>Comfortable</button>
              <button type="button" className={density === 'compact' ? 'active' : ''} onClick={() => setDensity('compact')}>Compact</button>
            </div>
          </Field>
          <span className="hint">Appearance settings are remembered in this browser.</span>
        </div>

        <div className="card card-pad stack">
          <div>
            <h2>Language and time zone</h2>
            <p className="muted small">The menus, sign-in pages and dates follow your language. Some screens inside projects are still in English.</p>
          </div>
          <div className="form-grid">
            <Field label="Language">
              <select className="select" value={user.preferences?.language || 'en'} onChange={(e) => savePref({ language: e.target.value })}>
                {LANGUAGES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
              </select>
            </Field>
            <Field label="Time zone" hint={user.org?.timezone ? `Workspace default: ${user.org.timezone}` : 'Times are shown in this zone.'}>
              <select className="select" value={user.preferences?.timezone || ''} onChange={(e) => savePref({ timezone: e.target.value })}>
                <option value="">{user.org?.timezone ? 'Workspace default' : "This device's time zone"}</option>
                {timeZones().map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </Field>
          </div>
        </div>

        <TwoFactorCard />

        <MySessions />

        <form className="card card-pad stack" onSubmit={changePassword}>
          <h2>Change password</h2>
          {pwError && <div className="form-error">{pwError}</div>}
          <Field label="Current password">
            <PasswordInput value={current} onChange={setCurrent} />
          </Field>
          <div className="form-grid">
            <Field label="New password">
              <PasswordInput value={next} onChange={setNext} autoComplete="new-password" />
            </Field>
            <Field label="Confirm new password">
              <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
            </Field>
          </div>
          <PasswordRules password={next} />
          <div><button className="btn btn-primary" disabled={savingPw || !current || !passwordValid(next) || !confirm}>{savingPw ? <Spinner /> : 'Update password'}</button></div>
        </form>
      </div>
    </div>
  )
}
