import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Building2,
  CreditCard,
  Settings2,
  LifeBuoy,
  Briefcase,
  CalendarDays,
  Clock,
  Gauge,
  Trash2,
  CornerDownLeft,
  FolderKanban,
  GanttChart,
  Keyboard,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MessagesSquare,
  Monitor,
  Moon,
  PanelLeft,
  Search,
  Sun,
  UserRound,
  Users,
} from 'lucide-react'
import { api } from '../api'
import { useAuth, useTheme } from '../context'
import { Modal, ProjectIcon, TypeIcon, useOpenIssue } from '../ui'

export const SHORTCUTS = [
  [['Ctrl', 'K'], 'Open the command palette (⌘K on Mac)'],
  [['/'], 'Search projects'],
  [['G', 'D'], 'Go to Dashboard'],
  [['G', 'P'], 'Go to Projects'],
  [['G', 'R'], 'Go to Roadmap'],
  [['G', 'C'], 'Go to Calendar'],
  [['G', 'I'], 'Go to My issues'],
  [['G', 'T'], 'Go to Timesheet'],
  [['G', 'M'], 'Go to Chat (messages)'],
  [['G', 'O'], 'Go to Portfolio'],
  [['G', 'W'], 'Go to Workload'],
  [['['], 'Collapse or expand the sidebar'],
  [['?'], 'Show keyboard shortcuts'],
  [['Esc'], 'Close a dialog or panel'],
]

const GO = { d: '/', p: '/projects', r: '/roadmap', c: '/calendar', i: '/my-issues', t: '/timesheet', m: '/chat', o: '/portfolio', w: '/workload' }

const typing = (el) => el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))

export function ShortcutsHelp({ onClose }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} size="sm">
      <div className="modal-body">
        <div className="shortcut-grid">
          {SHORTCUTS.map(([keys, label]) => (
            <div key={label} style={{ display: 'contents' }}>
              <span className="row" style={{ gap: 4 }}>
                {keys.map((k, n) => <span key={k} className="row" style={{ gap: 4 }}>{n > 0 && <span className="faint small">then</span>}<kbd>{k}</kbd></span>)}
              </span>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

/**
 * Global keyboard handling plus the Ctrl/⌘+K palette.
 * open / setOpen are owned by the layout so a top bar button can open it too.
 */
export default function CommandPalette({ open, setOpen, onToggleSidebar }) {
  const navigate = useNavigate()
  const openIssue = useOpenIssue()
  const { user, logout } = useAuth()
  const { setTheme } = useTheme()
  const [query, setQuery] = useState('')
  const [projects, setProjects] = useState([])
  const [issues, setIssues] = useState([])
  const [active, setActive] = useState(0)
  const [help, setHelp] = useState(false)
  const listRef = useRef(null)
  const pendingG = useRef(0)

  // Global shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('.modal-backdrop, .palette-backdrop')) return
      const key = e.key.toLowerCase()
      if (Date.now() - pendingG.current < 1200 && GO[key]) {
        pendingG.current = 0
        e.preventDefault()
        navigate(GO[key])
      } else if (key === 'g') pendingG.current = Date.now()
      else if (e.key === '?') setHelp(true)
      else if (e.key === '[') onToggleSidebar()
      else if (e.key === '/') {
        e.preventDefault()
        document.querySelector('input[aria-label="Search projects"]')?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, setOpen, onToggleSidebar])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIssues([])
    setActive(0)
    api('/projects').then(setProjects).catch(() => {})
  }, [open])

  // Issue search as you type
  useEffect(() => {
    const term = query.trim()
    if (!open || term.length < 2) {
      setIssues([])
      return undefined
    }
    let stale = false
    const timer = setTimeout(() => {
      api(`/issues?limit=6&q=${encodeURIComponent(term)}`).then((rows) => !stale && setIssues(rows)).catch(() => {})
    }, 180)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query, open])

  const sections = useMemo(() => {
    const term = query.trim().toLowerCase()
    const match = (text) => !term || text.toLowerCase().includes(term)
    const run = (fn) => () => {
      setOpen(false)
      fn()
    }
    const mod = user.org?.modules || {}
    const pages = [
      { icon: LayoutDashboard, label: 'Dashboard', hint: 'G D', to: '/' },
      { icon: FolderKanban, label: 'Projects', hint: 'G P', to: '/projects' },
      { icon: GanttChart, label: 'Roadmap', hint: 'G R', to: '/roadmap' },
      { icon: CalendarDays, label: 'Calendar', hint: 'G C', to: '/calendar' },
      { icon: ListChecks, label: 'My issues', hint: 'G I', to: '/my-issues' },
      ...(mod.time === false ? [] : [{ icon: Clock, label: 'Timesheet', hint: 'G T', to: '/timesheet' }]),
      ...(mod.portfolio === false ? [] : [{ icon: Briefcase, label: 'Portfolio', hint: 'G O', to: '/portfolio' }]),
      ...(mod.workload === false ? [] : [{ icon: Gauge, label: 'Workload', hint: 'G W', to: '/workload' }]),
      { icon: Trash2, label: 'Recycle bin', to: '/trash' },
      ...(mod.chat === false ? [] : [{ icon: MessagesSquare, label: 'Chat', hint: 'G M', to: '/chat' }]),
      { icon: UserRound, label: 'Profile and appearance', to: '/profile' },
      ...(user.role === 'admin' ? [{ icon: Users, label: 'Users', to: '/users' }, { icon: Settings2, label: 'Workspace settings', to: '/settings' }, { icon: CreditCard, label: 'Billing and license', to: '/billing' }] : []),
      { icon: LifeBuoy, label: 'Help and support', to: '/support' },
      ...(user.is_platform_admin ? [{ icon: Building2, label: 'Owner console', to: '/platform' }] : []),
    ]
    const actions = [
      { icon: PanelLeft, label: 'Collapse or expand the sidebar', hint: '[', action: onToggleSidebar },
      { icon: Sun, label: 'Use light theme', action: () => setTheme('light') },
      { icon: Moon, label: 'Use dark theme', action: () => setTheme('dark') },
      { icon: Monitor, label: 'Follow the system theme', action: () => setTheme('system') },
      { icon: Keyboard, label: 'Show keyboard shortcuts', hint: '?', action: () => setHelp(true) },
      { icon: LogOut, label: 'Sign out', action: logout },
    ]
    return [
      {
        title: 'Projects',
        items: projects
          .filter((p) => match(`${p.name} ${p.key}`))
          .slice(0, term ? 6 : 4)
          .map((p) => ({ key: `p${p.id}`, node: <ProjectIcon project={p} size={24} />, label: p.name, hint: p.key, run: run(() => navigate(`/projects/${p.id}`)) })),
      },
      {
        title: 'Issues',
        items: issues.map((i) => ({ key: `i${i.id}`, node: <TypeIcon type={i.type} />, label: i.title, hint: i.key, run: run(() => openIssue(i.id)) })),
      },
      {
        title: 'Go to',
        items: pages.filter((p) => match(p.label)).map((p) => ({ key: p.to, node: <p.icon size={16} />, label: p.label, hint: p.hint, run: run(() => navigate(p.to)) })),
      },
      {
        title: 'Actions',
        items: actions.filter((a) => match(a.label)).map((a) => ({ key: a.label, node: <a.icon size={16} />, label: a.label, hint: a.hint, run: run(a.action) })),
      },
    ].filter((s) => s.items.length)
  }, [query, projects, issues, user.role, user.org, navigate, openIssue, logout, setTheme, setOpen, onToggleSidebar])

  const flat = sections.flatMap((s) => s.items)

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKeyDown = (e) => {
    if (e.key === 'Escape') setOpen(false)
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((n) => (flat.length ? (n + 1) % flat.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((n) => (flat.length ? (n - 1 + flat.length) % flat.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      flat[active]?.run()
    }
  }

  let index = -1
  return (
    <>
      {open && (
        <div className="palette-backdrop" onMouseDown={() => setOpen(false)}>
          <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
            <div className="palette-input">
              <Search size={17} />
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} placeholder="Search projects and issues, or type a command…" aria-label="Command palette search" />
              <kbd>Esc</kbd>
            </div>
            <div className="palette-list" ref={listRef}>
              {flat.length === 0 && <div className="muted" style={{ padding: 18, textAlign: 'center' }}>Nothing matches “{query.trim()}”.</div>}
              {sections.map((section) => (
                <div key={section.title}>
                  <div className="palette-section">{section.title}</div>
                  {section.items.map((item) => {
                    index += 1
                    const n = index
                    return (
                      <button key={item.key} className={`palette-item ${n === active ? 'active' : ''}`} onMouseEnter={() => setActive(n)} onClick={item.run}>
                        {item.node}
                        <span className="truncate">{item.label}</span>
                        {item.hint && <span className="hint">{item.hint}</span>}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
            <div className="palette-foot">
              <span><kbd>↑</kbd> <kbd>↓</kbd> to move</span>
              <span><CornerDownLeft size={11} style={{ verticalAlign: -1 }} /> to open</span>
              <span><kbd>?</kbd> for all shortcuts</span>
            </div>
          </div>
        </div>
      )}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
    </>
  )
}
