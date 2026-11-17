import { useEffect, useState } from 'react'
import { Copy, Download, KeyRound, ShieldCheck, Smartphone } from 'lucide-react'
import { api } from '../api'
import { useAuth, useToast } from '../context'
import { Field, Modal, Spinner, formatDate } from '../ui'

/** A 6-digit code box that accepts pasted codes with spaces. */
export function CodeInput({ value, onChange, autoFocus, recovery = false }) {
  return (
    <input
      className="input code-input"
      value={value}
      onChange={(e) => onChange(recovery ? e.target.value.slice(0, 20) : e.target.value.replace(/\D/g, '').slice(0, 6))}
      inputMode={recovery ? 'text' : 'numeric'}
      autoComplete="one-time-code"
      placeholder={recovery ? 'xxxxx-xxxxx' : '123456'}
      maxLength={recovery ? 20 : 6}
      autoFocus={autoFocus}
      required
      aria-label={recovery ? 'Recovery code' : 'Six-digit code'}
    />
  )
}

/** The recovery codes, shown once, with copy and download. */
export function RecoveryCodes({ codes }) {
  const toast = useToast()
  const text = codes.join('\n')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast('Recovery codes copied')
    } catch {
      toast('Could not copy. Select the codes and copy them by hand.', 'error')
    }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([`Trackly recovery codes\nEach code works once.\n\n${text}\n`], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'trackly-recovery-codes.txt'
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="callout">
        <KeyRound size={16} />
        <span>Keep these somewhere safe, like a password manager. If you lose your phone, each code lets you sign in once. They are shown only now.</span>
      </div>
      <div className="recovery-codes">{codes.map((c) => <code key={c}>{c}</code>)}</div>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-sm" onClick={copy}><Copy size={13} /> Copy</button>
        <button type="button" className="btn btn-sm" onClick={download}><Download size={13} /> Download</button>
      </div>
    </div>
  )
}

/**
 * Setting up two-factor sign-in: scan the QR code, confirm with a code, save the recovery codes.
 * onDone(user) runs after the recovery codes have been acknowledged.
 */
export function TwoFactorSetup({ onDone, onCancel }) {
  const toast = useToast()
  const [setup, setSetup] = useState(null)
  const [code, setCode] = useState('')
  const [result, setResult] = useState(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api('/auth/2fa/setup', { method: 'POST' }).then(setSetup).catch((e) => setError(e.message))
  }, [])

  const confirm = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      setResult(await api('/auth/2fa/enable', { method: 'POST', body: { code } }))
    } catch (err) {
      setError(err.message)
      setCode('')
    }
    setBusy(false)
  }
  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(setup.secret.replace(/\s/g, ''))
      toast('Setup key copied')
    } catch {
      toast('Could not copy the key', 'error')
    }
  }

  if (result) {
    return (
      <div className="stack">
        <div className="form-success">Two-factor sign-in is on. From now on you enter a code from your app after your password.</div>
        <RecoveryCodes codes={result.recovery_codes} />
        <label className="opt-row"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved my recovery codes</label>
        <div><button type="button" className="btn btn-primary" disabled={!saved} onClick={() => onDone(result.user)}>Done</button></div>
      </div>
    )
  }
  if (!setup) return error ? <div className="form-error">{error}</div> : <Spinner />
  return (
    <form className="stack" onSubmit={confirm}>
      {error && <div className="form-error">{error}</div>}
      <ol className="setup-steps">
        <li>
          <b>Install an authenticator app</b> on your phone, for example Google Authenticator, Microsoft Authenticator or 1Password.
        </li>
        <li>
          <b>Scan this code</b> with the app.
          <div className="qr-row">
            <div className="qr-box" dangerouslySetInnerHTML={{ __html: setup.qr_svg }} role="img" aria-label="QR code for your authenticator app" />
            <div className="small muted">
              Cannot scan? Enter this key in the app instead:
              <div className="secret-box" style={{ marginTop: 6, padding: '8px 10px' }}>
                <code style={{ fontSize: 13 }}>{setup.secret}</code>
                <button type="button" className="btn btn-sm btn-icon" onClick={copySecret} aria-label="Copy setup key"><Copy size={13} /></button>
              </div>
            </div>
          </div>
        </li>
        <li>
          <b>Enter the 6-digit code</b> the app shows.
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <CodeInput value={code} onChange={setCode} autoFocus />
            <button className="btn btn-primary" disabled={busy || code.length !== 6}>{busy ? <Spinner /> : 'Turn on'}</button>
            {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
          </div>
        </li>
      </ol>
    </form>
  )
}

/** Profile card: status, turn on, new recovery codes, turn off. */
export function TwoFactorCard() {
  const { user, setUser } = useAuth()
  const toast = useToast()
  const [status, setStatus] = useState(null)
  const [mode, setMode] = useState(null) // 'setup' | 'disable' | 'codes'
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [codes, setCodes] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = () => api('/auth/2fa').then(setStatus).catch(() => {})
  useEffect(() => { load() }, [user.two_factor_enabled])

  const close = () => {
    setMode(null)
    setCode('')
    setPassword('')
    setCodes(null)
  }
  const disable = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      setUser(await api('/auth/2fa/disable', { method: 'POST', body: { password, code } }))
      toast('Two-factor sign-in is off')
      close()
    } catch (err) {
      toast(err.message, 'error')
    }
    setBusy(false)
  }
  const renew = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      setCodes((await api('/auth/2fa/recovery-codes', { method: 'POST', body: { code } })).recovery_codes)
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
    setBusy(false)
  }

  if (!status) return null
  return (
    <div className="card card-pad stack">
      <div className="row between row-wrap" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 className="icon-label"><ShieldCheck size={17} /> <span>Two-factor sign-in</span></h2>
          <p className="muted small">After your password, you also enter a code from an app on your phone. Someone who learns your password still cannot get in.</p>
        </div>
        {status.enabled ? <span className="tag on">On</span> : <span className="tag">Off</span>}
      </div>
      {status.enabled ? (
        <>
          <div className="small muted">
            On since {formatDate(status.enabled_at, true)} · {status.recovery_codes_left} of 10 recovery codes left
            {status.recovery_codes_left <= 3 && <span className="danger-text"> · make new ones soon</span>}
          </div>
          <div className="row row-wrap" style={{ gap: 8 }}>
            <button className="btn btn-sm" onClick={() => setMode('codes')}><KeyRound size={13} /> New recovery codes</button>
            {status.required
              ? <span className="small muted">Your workspace requires it, so it cannot be turned off.</span>
              : <button className="btn btn-ghost btn-sm danger-text" onClick={() => setMode('disable')}>Turn off</button>}
          </div>
        </>
      ) : (
        <div><button className="btn btn-primary btn-sm" onClick={() => setMode('setup')}><Smartphone size={14} /> Set up two-factor sign-in</button></div>
      )}

      {mode === 'setup' && (
        <Modal title="Set up two-factor sign-in" onClose={close}>
          <div className="modal-body">
            <TwoFactorSetup onCancel={close} onDone={(u) => { setUser(u); close(); load() }} />
          </div>
        </Modal>
      )}
      {mode === 'disable' && (
        <Modal title="Turn off two-factor sign-in?" onClose={close} size="sm">
          <form onSubmit={disable}>
            <div className="modal-body stack">
              <p className="muted">Your account will be protected by your password only.</p>
              <Field label="Password"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus /></Field>
              <Field label="Code from your app, or a recovery code"><CodeInput value={code} onChange={setCode} recovery /></Field>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost" onClick={close}>Cancel</button>
              <button className="btn btn-danger" disabled={busy}>{busy ? <Spinner /> : 'Turn off'}</button>
            </div>
          </form>
        </Modal>
      )}
      {mode === 'codes' && (
        <Modal title="New recovery codes" onClose={close} size="sm">
          {codes ? (
            <>
              <div className="modal-body stack"><RecoveryCodes codes={codes} /><span className="small muted">Your old recovery codes no longer work.</span></div>
              <div className="modal-footer"><button className="btn btn-primary" onClick={close}>Done</button></div>
            </>
          ) : (
            <form onSubmit={renew}>
              <div className="modal-body stack">
                <p className="muted">New codes replace all your current ones.</p>
                <Field label="Code from your authenticator app"><CodeInput value={code} onChange={setCode} autoFocus /></Field>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={close}>Cancel</button>
                <button className="btn btn-primary" disabled={busy || code.length !== 6}>{busy ? <Spinner /> : 'Make new codes'}</button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </div>
  )
}
