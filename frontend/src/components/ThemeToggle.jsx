import { useEffect, useRef, useState } from 'react'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from '../context'

const OPTIONS = [
  { key: 'system', label: 'System', hint: 'Follows your device', icon: Monitor },
  { key: 'light', label: 'Light', hint: 'Always light', icon: Sun },
  { key: 'dark', label: 'Dark', hint: 'Always dark', icon: Moon },
]

/** Which look is actually on screen right now (resolves "system"). */
function useResolved(theme) {
  const [dark, setDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!query) return undefined
    const onChange = (e) => setDark(e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return theme === 'system' ? (dark ? 'dark' : 'light') : theme
}

/**
 * Theme chooser.
 * Default: one round button showing the current look; it opens a small menu.
 * `labels`: three preview cards, for the profile page.
 */
export default function ThemeToggle({ labels = false }) {
  const { theme, setTheme } = useTheme()
  const resolved = useResolved(theme)
  const [open, setOpen] = useState(false)
  const box = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => !box.current?.contains(e.target) && setOpen(false)
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (labels) {
    return (
      <div className="theme-cards" role="radiogroup" aria-label="Theme">
        {OPTIONS.map(({ key, label, hint, icon: Icon }) => (
          <button key={key} type="button" role="radio" aria-checked={theme === key} className={`theme-card ${theme === key ? 'active' : ''}`} onClick={() => setTheme(key)}>
            <span className={`theme-preview ${key}`} aria-hidden="true"><i /><i /><i /></span>
            <span className="theme-card-text">
              <b><Icon size={14} /> {label}</b>
              <span>{hint}</span>
            </span>
            {theme === key && <span className="theme-card-check"><Check size={12} strokeWidth={3} /></span>}
          </button>
        ))}
      </div>
    )
  }

  const Current = resolved === 'dark' ? Moon : Sun
  return (
    <div className="theme-menu" ref={box}>
      <button type="button" className={`theme-btn ${resolved}`} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label={`Theme: ${theme}. Change theme`} title="Change theme">
        <Current size={16} />
      </button>
      {open && (
        <div className="theme-pop" role="menu">
          {OPTIONS.map(({ key, label, hint, icon: Icon }) => (
            <button key={key} type="button" role="menuitemradio" aria-checked={theme === key} className={theme === key ? 'active' : ''} onClick={() => { setTheme(key); setOpen(false) }}>
              <span className="theme-pop-icon"><Icon size={15} /></span>
              <span className="grow"><b>{label}</b><span>{hint}</span></span>
              {theme === key && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
