import { useEffect, useRef, useState, useCallback } from 'react'
import { Link, NavLink, Outlet, useLocation, useSearchParams, useNavigate } from 'react-router-dom'
import {
  CalendarDays,
  Briefcase,
  LifeBuoy,
  Megaphone,
  X,
  Building2,
  CreditCard,
  Settings2,
  Check,
  Clock,
  Gauge,
  Trash2,
  Command,
  PanelLeftClose,
  PanelLeftOpen,
  FolderKanban,
  GanttChart,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  MessagesSquare,
  Search,
  Users,
} from 'lucide-react'
import { api, onChanged } from '../api'
import { useAuth } from '../context'
import { Avatar, ProjectIcon, ProjectStatusBadge, roleLabel } from '../ui'
import ThemeToggle from './ThemeToggle'
import IssueModal from './IssueModal'
import NotificationBell from './NotificationBell'
import CommandPalette from './CommandPalette'
import { onRealtime } from '../realtime'
import { LicenseBanner } from './License'
import { setLocale, useT } from '../i18n'

function GlobalSearch() {
  const navigate = useNavigate()
  const t = useT()
  const [query, setQuery] = useState('')
  const [projects, setProjects] = useState(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const boxRef = useRef(null)

  // The project list is small, so it is loaded once and filtered as you type.
  const load = () => api('/projects').then(setProjects).catch(() => setProjects([]))
  useEffect(() => onChanged(() => projects && load()), [projects]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onClick = (e) => !boxRef.current?.contains(e.target) && setOpen(false)
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const term = query.trim().toLowerCase()
  const results = term && projects
    ? projects
        .filter((p) => `${p.name} ${p.key} ${p.description} ${p.owner?.full_name || ''}`.toLowerCase().includes(term))
        .sort((a, b) => (b.name.toLowerCase().startsWith(term) || b.key.toLowerCase() === term) - (a.name.toLowerCase().startsWith(term) || a.key.toLowerCase() === term))
        .slice(0, 8)
    : null

  const go = (project) => {
    navigate(`/projects/${project.id}`)
    setOpen(false)
    setQuery('')
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') return setOpen(false)
    if (!results?.length) return
    if (e.key === 'ArrowDown') return e.preventDefault(), setActive((n) => (n + 1) % results.length)
    if (e.key === 'ArrowUp') return e.preventDefault(), setActive((n) => (n - 1 + results.length) % results.length)
    if (e.key === 'Enter') go(results[Math.min(active, results.length - 1)])
  }

  return (
    <div className="search" ref={boxRef}>
      <div className="input-icon">
        <Search size={15} />
        <input
          className="input input-sm"
          placeholder={t('top.search')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
            setOpen(true)
            if (!projects) load()
          }}
          onFocus={() => {
            setOpen(true)
            if (!projects) load()
          }}
          onKeyDown={onKeyDown}
          aria-label="Search projects"
        />
      </div>
      {open && term && (
        <div className="search-results">
          {!results ? (
            <div className="muted small" style={{ padding: 10 }}>Searching…</div>
          ) : results.length === 0 ? (
            <div className="muted small" style={{ padding: 10 }}>No projects match “{query.trim()}”.</div>
          ) : (
            results.map((p, n) => (
              <button key={p.id} className="search-item" style={n === active ? { background: 'var(--surface-2)' } : undefined} onMouseEnter={() => setActive(n)} onClick={() => go(p)}>
                <ProjectIcon project={p} size={26} />
                <span className="grow truncate">
                  <span style={{ fontWeight: 600 }}>{p.name}</span>{' '}
                  <span className="faint small">{p.key}{p.owner ? ` · ${p.owner.full_name}` : ''}</span>
                </span>
                <ProjectStatusBadge status={p.status} />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export default function Layout() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const [pendingResets, setPendingResets] = useState(0)
  const [pendingLicenses, setPendingLicenses] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const [chatUnread, setChatUnread] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('pm_sidebar') === 'collapsed'
    } catch {
      return false
    }
  })
  const toggleSidebar = useCallback(() => {
    setCollapsed((value) => {
      try {
        localStorage.setItem('pm_sidebar', value ? 'open' : 'collapsed')
      } catch {
        /* ignore */
      }
      return !value
    })
  }, [])
  const isAdmin = user.role === 'admin'
  const mod = user.org?.modules || {}
  const t = useT()

  // Language and time zone: the person's own choice, else the workspace's time zone.
  const prefs = user.preferences || {}
  useEffect(() => {
    setLocale({ language: prefs.language || 'en', timeZone: prefs.timezone || user.org?.timezone || '' })
  }, [prefs.language, prefs.timezone, user.org?.timezone])

  // The workspace's colour is the default accent until someone picks their own.
  useEffect(() => {
    let own = null
    try {
      own = localStorage.getItem('pm_accent')
    } catch {
      /* ignore */
    }
    if (!own && user.org?.brand_color) document.documentElement.style.setProperty('--accent', user.org.brand_color)
  }, [user.org?.brand_color])

  const [notices, setNotices] = useState([])
  const [hidden, setHidden] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('pm_notices_hidden') || '[]')
    } catch {
      return []
    }
  })
  useEffect(() => {
    api('/announcements').then(setNotices).catch(() => {})
  }, [])
  const hideNotice = (id) => {
    const next = [...hidden, id].slice(-50)
    setHidden(next)
    try {
      localStorage.setItem('pm_notices_hidden', JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    const load = () => {
      if (isAdmin) {
        api('/admin/reset-requests')
          .then((rows) => setPendingResets(rows.filter((r) => r.status === 'pending').length))
          .catch(() => {})
      }
      if (user.is_platform_admin) {
        api('/platform/requests?status=pending').then((rows) => setPendingLicenses(rows.length)).catch(() => {})
      }
    }
    load()
    const offNotify = onRealtime('notify', load)
    const offChanged = onChanged(load)
    return () => {
      offNotify()
      offChanged()
    }
  }, [isAdmin, user.is_platform_admin])

  useEffect(() => {
    const load = () => api('/chat/unread').then((r) => setChatUnread(r.count)).catch(() => {})
    load()
    // Live updates arrive instantly; the timer is only a safety net if the connection drops.
    const timer = setInterval(load, 45000)
    window.addEventListener('pm:chat-read', load)
    const offMessage = onRealtime('chat.message', load)
    const offDeleted = onRealtime('chat.deleted', load)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pm:chat-read', load)
      offMessage()
      offDeleted()
    }
  }, [])

  useEffect(() => setMenuOpen(false), [location.pathname])

  const issueId = params.get('issue')
  const closeIssue = () =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('issue')
      return next
    })

  const navClass = ({ isActive }) => `nav-item ${isActive ? 'active' : ''}`

  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      <div className={`backdrop-mobile ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)} />
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <Link to="/" className="brand">
          {user.org?.logo_url ? <img src={user.org.logo_url} alt="" className="brand-logo" /> : (
            <span className="brand-mark">
              <Check size={18} strokeWidth={3} />
            </span>
          )}
          <span className="brand-name truncate">{user.org?.logo_url ? user.org.name : 'Trackly'}</span>
        </Link>
        {user.org && !user.org.logo_url && <div className="workspace-name truncate" title="Your workspace"><Building2 size={13} /> <span className="nav-label">{user.org.name}</span></div>}

        <NavLink to="/" end className={navClass} title={collapsed ? "Dashboard" : undefined}>
          <LayoutDashboard size={17} /> <span className="nav-label">{t('nav.dashboard')}</span>
        </NavLink>
        <NavLink to="/projects" end className={navClass} title={collapsed ? "Projects" : undefined}>
          <FolderKanban size={17} /> <span className="nav-label">{t('nav.projects')}</span>
        </NavLink>
        <NavLink to="/roadmap" className={navClass} title={collapsed ? "Roadmap" : undefined}>
          <GanttChart size={17} /> <span className="nav-label">{t('nav.roadmap')}</span>
        </NavLink>
        <NavLink to="/calendar" className={navClass} title={collapsed ? "Calendar" : undefined}>
          <CalendarDays size={17} /> <span className="nav-label">{t('nav.calendar')}</span>
        </NavLink>
        <NavLink to="/my-issues" className={navClass} title={collapsed ? "My issues" : undefined}>
          <ListChecks size={17} /> <span className="nav-label">{t('nav.myIssues')}</span>
        </NavLink>
        {mod.portfolio !== false && (
          <NavLink to="/portfolio" className={navClass} title={collapsed ? "Portfolio" : undefined}>
            <Briefcase size={17} /> <span className="nav-label">{t('nav.portfolio')}</span>
          </NavLink>
        )}
        {mod.workload !== false && (
          <NavLink to="/workload" className={navClass} title={collapsed ? "Workload" : undefined}>
            <Gauge size={17} /> <span className="nav-label">{t('nav.workload')}</span>
          </NavLink>
        )}
        {mod.time !== false && (
          <NavLink to="/timesheet" className={navClass} title={collapsed ? "Timesheet" : undefined}>
            <Clock size={17} /> <span className="nav-label">{t('nav.timesheet')}</span>
          </NavLink>
        )}
        {mod.chat !== false && (
          <NavLink to="/chat" className={navClass} title={collapsed ? "Chat" : undefined}>
            <MessagesSquare size={17} /> <span className="nav-label">{t('nav.chat')}</span>
            {chatUnread > 0 && <span className="count" title="Unread messages">{chatUnread > 99 ? '99+' : chatUnread}</span>}
          </NavLink>
        )}
        {isAdmin && (
          <NavLink to="/users" className={navClass} title={collapsed ? "Users" : undefined}>
            <Users size={17} /> <span className="nav-label">{t('nav.users')}</span>
            {pendingResets > 0 && <span className="count" title="Pending password reset requests">{pendingResets}</span>}
          </NavLink>
        )}
        {isAdmin && (
          <NavLink to="/settings" className={navClass} title={collapsed ? 'Workspace settings' : undefined}>
            <Settings2 size={17} /> <span className="nav-label">{t('nav.settings')}</span>
          </NavLink>
        )}
        {isAdmin && (
          <NavLink to="/billing" className={navClass} title={collapsed ? 'Billing' : undefined}>
            <CreditCard size={17} /> <span className="nav-label">{t('nav.billing')}</span>
          </NavLink>
        )}
        {user.is_platform_admin && (
          <NavLink to="/platform" className={navClass} title={collapsed ? 'Owner console' : undefined}>
            <Building2 size={17} /> <span className="nav-label">{t('nav.owner')}</span>
            {pendingLicenses > 0 && <span className="count" title="License requests waiting">{pendingLicenses}</span>}
          </NavLink>
        )}

        <div className="sidebar-footer">
          <Link to="/profile" className="user-chip">
            <Avatar user={user} size={34} />
            <span className="grow">
              <div className="truncate" style={{ fontWeight: 600 }}>{user.full_name}</div>
              <div className="truncate small faint">{roleLabel(user.role)} · @{user.username}</div>
            </span>
          </Link>
          <NavLink to="/support" className={navClass} title={collapsed ? t('nav.support') : undefined}>
            <LifeBuoy size={17} /> <span className="nav-label">{t('nav.support')}</span>
          </NavLink>
          <NavLink to="/trash" className={navClass} title={collapsed ? 'Recycle bin' : undefined}>
            <Trash2 size={17} /> <span className="nav-label">{t('nav.trash')}</span>
          </NavLink>
          <button className="nav-item hide-mobile" style={{ width: collapsed ? 44 : '100%', border: 0, background: 'none', cursor: 'pointer' }} onClick={toggleSidebar} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-pressed={collapsed}>
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />} <span className="nav-label">{t('nav.collapse')}</span>
          </button>
          <button className="nav-item" style={{ width: collapsed ? 44 : '100%', border: 0, background: 'none', cursor: 'pointer' }} onClick={logout} title={collapsed ? 'Sign out' : undefined}>
            <LogOut size={17} /> <span className="nav-label">{t('nav.signOut')}</span>
          </button>
        </div>
      </aside>

      <div className={`main ${user.org?.read_only && !/^\/(billing|platform)/.test(location.pathname) ? 'read-only' : ''}`}>
        <header className="topbar">
          <button className="btn btn-icon btn-ghost menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Menu size={18} />
          </button>
          <GlobalSearch />
          <button className="kbd-hint" onClick={() => setPaletteOpen(true)} title="Open the command palette">
            <Command size={13} /> {t('top.commands')} <kbd>Ctrl K</kbd>
          </button>
          <span className="grow" />
          <span className="hide-mobile"><ThemeToggle /></span>
          <NotificationBell />
        </header>
        <LicenseBanner />
        {notices.filter((n) => !hidden.includes(n.id)).map((n) => (
          <div key={n.id} className={`license-banner ${n.level === 'warning' ? 'warn' : ''}`}>
            <Megaphone size={16} />
            <span className="grow"><b>{n.title}</b>{n.body ? ` ${n.body}` : ''}</span>
            <button className="btn btn-ghost btn-sm btn-icon" onClick={() => hideNotice(n.id)} aria-label="Dismiss announcement"><X size={14} /></button>
          </div>
        ))}
        <Outlet />
      </div>

      <CommandPalette open={paletteOpen} setOpen={setPaletteOpen} onToggleSidebar={toggleSidebar} />
      {issueId && <IssueModal key={issueId} issueId={issueId} onClose={closeIssue} />}
    </div>
  )
}
