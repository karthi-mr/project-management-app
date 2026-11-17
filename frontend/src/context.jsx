import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import { api, getToken, setToken } from './api'
import { connectRealtime, disconnectRealtime, onRealtime } from './realtime'

/* ───────────── Auth ───────────── */

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(Boolean(getToken()))

  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
  }, [])

  const setSession = useCallback((session) => {
    if (session.access_token) setToken(session.access_token)
    setUser(session.user)
  }, [])

  const refresh = useCallback(async () => {
    const me = await api('/auth/me')
    setUser(me)
    return me
  }, [])

  useEffect(() => {
    if (!getToken()) return
    refresh()
      .catch(() => logout())
      .finally(() => setLoading(false))
  }, [refresh, logout])

  // Second sign-in step: the authenticator or recovery code.
  const finishLogin = useCallback(
    async (challenge, code) => {
      const session = await api('/auth/login/2fa', { method: 'POST', body: { challenge, code } })
      setSession(session)
      return session
    },
    [setSession],
  )

  // Hold the live connection open only while someone is fully signed in.
  const signedIn = Boolean(user && !user.must_change_password && !user.two_factor_setup_required)
  useEffect(() => {
    if (!signedIn) return undefined
    connectRealtime()
    // A license change (activation, suspension) arrives as a notification: pick up the new state.
    const sync = () => refresh().catch(() => {})
    const off = onRealtime('notify', sync)
    window.addEventListener('pm:license', sync)
    return () => {
      off()
      window.removeEventListener('pm:license', sync)
      disconnectRealtime()
    }
  }, [signedIn, refresh])

  useEffect(() => {
    const onUnauthorized = () => logout()
    const onPasswordRequired = () => setUser((u) => (u ? { ...u, must_change_password: true } : u))
    const onTwoFactorRequired = () => setUser((u) => (u ? { ...u, two_factor_setup_required: true } : u))
    window.addEventListener('pm:unauthorized', onUnauthorized)
    window.addEventListener('pm:password-required', onPasswordRequired)
    window.addEventListener('pm:two-factor-required', onTwoFactorRequired)
    return () => {
      window.removeEventListener('pm:unauthorized', onUnauthorized)
      window.removeEventListener('pm:password-required', onPasswordRequired)
      window.removeEventListener('pm:two-factor-required', onTwoFactorRequired)
    }
  }, [logout])

  const login = useCallback(
    async (username, password) => {
      const session = await api('/auth/login', { method: 'POST', body: { username, password } })
      if (session.two_factor_required) return { challenge: session.challenge } // the code comes next
      setSession(session)
      return session.user
    },
    [setSession],
  )

  const value = useMemo(
    () => ({ user, loading, login, finishLogin, logout, setSession, setUser, refresh }),
    [user, loading, login, finishLogin, logout, setSession, refresh],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/* ───────────── Theme ───────────── */

const ThemeContext = createContext(null)
export const useTheme = () => useContext(ThemeContext)

function readPref(key, fallback, valid) {
  try {
    const stored = localStorage.getItem(key)
    return stored && valid(stored) ? stored : fallback
  } catch {
    return fallback
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

function readThemePref() {
  try {
    const stored = localStorage.getItem('pm_theme')
    return ['light', 'dark', 'system'].includes(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readThemePref) // 'system' | 'light' | 'dark'

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  const setTheme = useCallback((next) => {
    setThemeState(next)
    try {
      localStorage.setItem('pm_theme', next)
    } catch {
      /* ignore */
    }
  }, [])

  const [accent, setAccentState] = useState(() => readPref('pm_accent', '#6366f1', (v) => /^#[0-9a-f]{6}$/i.test(v)))
  const [density, setDensityState] = useState(() => readPref('pm_density', 'comfortable', (v) => v === 'compact' || v === 'comfortable'))

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent)
  }, [accent])
  useEffect(() => {
    document.documentElement.dataset.density = density
  }, [density])

  const setAccent = useCallback((next) => {
    setAccentState(next)
    writePref('pm_accent', next)
  }, [])
  const setDensity = useCallback((next) => {
    setDensityState(next)
    writePref('pm_density', next)
  }, [])

  const value = useMemo(
    () => ({ theme, setTheme, accent, setAccent, density, setDensity }),
    [theme, setTheme, accent, setAccent, density, setDensity],
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/* ───────────── Toasts + confirm dialog ───────────── */

const FeedbackContext = createContext(null)
export const useToast = () => useContext(FeedbackContext).toast
export const useConfirm = () => useContext(FeedbackContext).confirm

const TOAST_ICONS = { success: CheckCircle2, error: XCircle, info: Info }

export function FeedbackProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const [dialog, setDialog] = useState(null)
  const nextId = useRef(1)

  // options.action = { label, onClick } adds a button (for example "Undo") and keeps the toast longer.
  const toast = useCallback((message, type = 'success', options = {}) => {
    const id = nextId.current++
    setToasts((list) => [...list, { id, message, type, action: options.action }])
    const ms = options.action ? 8000 : type === 'error' ? 6000 : 3500
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), ms)
  }, [])

  const confirm = useCallback(
    (options) => new Promise((resolve) => setDialog({ ...options, resolve })),
    [],
  )

  const close = (result) => {
    dialog?.resolve(result)
    setDialog(null)
  }

  const value = useMemo(() => ({ toast, confirm }), [toast, confirm])

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => {
          const Icon = TOAST_ICONS[t.type] || Info
          return (
            <div key={t.id} className={`toast toast-${t.type}`}>
              <Icon size={18} />
              <span className="grow">{t.message}</span>
              {t.action && (
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setToasts((list) => list.filter((x) => x.id !== t.id))
                    t.action.onClick()
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          )
        })}
      </div>
      {dialog && (
        <div className="modal-backdrop" onMouseDown={() => close(false)}>
          <div className="modal modal-sm" role="alertdialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="confirm-body">
              <div className={`confirm-icon ${dialog.danger ? 'danger' : ''}`}>
                <AlertTriangle size={20} />
              </div>
              <div>
                <h3>{dialog.title}</h3>
                {dialog.message && <p className="muted">{dialog.message}</p>}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => close(false)}>
                Cancel
              </button>
              <button
                className={`btn ${dialog.danger ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => close(true)}
                autoFocus
              >
                {dialog.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </FeedbackContext.Provider>
  )
}
