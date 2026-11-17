import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  AlertOctagon,
  Bookmark,
  Bug,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  ChevronsUp,
  Equal,
  Loader2,
  X,
  Zap,
} from 'lucide-react'
import { localeTag, withZone } from './i18n'

/* ───────────── Constants ───────────── */

export const STATUSES = [
  { key: 'backlog', label: 'Backlog', color: '#94a3b8' },
  { key: 'todo', label: 'To do', color: '#3b82f6' },
  { key: 'in_progress', label: 'In progress', color: '#f59e0b' },
  { key: 'in_review', label: 'In review', color: '#a855f7' },
  { key: 'done', label: 'Done', color: '#22c55e' },
]

export const PRIORITIES = [
  { key: 'urgent', label: 'Urgent', color: '#ef4444', icon: AlertOctagon },
  { key: 'high', label: 'High', color: '#f97316', icon: ChevronsUp },
  { key: 'medium', label: 'Medium', color: '#eab308', icon: Equal },
  { key: 'low', label: 'Low', color: '#38bdf8', icon: ChevronDown },
]

export const TYPES = [
  { key: 'task', label: 'Task', color: '#3b82f6', icon: CheckSquare },
  { key: 'bug', label: 'Bug', color: '#ef4444', icon: Bug },
  { key: 'story', label: 'Story', color: '#22c55e', icon: Bookmark },
  { key: 'epic', label: 'Epic', color: '#a855f7', icon: Zap },
]

export const PROJECT_STATUSES = [
  { key: 'planning', label: 'Planning', color: '#a855f7' },
  { key: 'active', label: 'Active', color: '#22c55e' },
  { key: 'on_hold', label: 'On hold', color: '#f59e0b' },
  { key: 'completed', label: 'Completed', color: '#3b82f6' },
  { key: 'archived', label: 'Archived', color: '#94a3b8' },
]

export const PROJECT_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
]

export const byKey = (list, key) => list.find((x) => x.key === key) || list[0]

/* ───────────── Formatting ───────────── */

export function formatDate(value, withYear = false) {
  if (!value) return ''
  // Date-only strings are local calendar days, not UTC instants.
  const d = value.length === 10 ? new Date(`${value}T00:00:00`) : new Date(value)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const options = { month: 'short', day: 'numeric', year: withYear || !sameYear ? 'numeric' : undefined }
  // Calendar days are shown as they are; moments in time follow the chosen time zone.
  return d.toLocaleDateString(localeTag(), value.length === 10 ? options : withZone(options))
}

export function timeAgo(value) {
  if (!value) return 'never'
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d ago`
  return formatDate(value)
}

export function isOverdue(dueDate, done = false) {
  if (!dueDate || done) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return new Date(`${dueDate}T00:00:00`) < today
}

export function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/* ───────────── Hooks ───────────── */

/** Open the issue drawer from anywhere by setting ?issue=<id> on the current URL. */
export function useOpenIssue() {
  const [, setParams] = useSearchParams()
  return (id) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('issue', String(id))
      return next
    })
}

/* ───────────── Components ───────────── */

export function Spinner({ page = false }) {
  const icon = <Loader2 className="spin" size={page ? 28 : 16} />
  return page ? <div className="page-loader">{icon}</div> : icon
}

export function Avatar({ user, size = 28, title }) {
  if (!user) {
    return (
      <span
        className="avatar avatar-empty"
        style={{ width: size, height: size, fontSize: size * 0.4 }}
        title={title || 'Unassigned'}
      >
        ?
      </span>
    )
  }
  if (user.avatar_url) {
    return (
      <img
        className="avatar avatar-img"
        src={user.avatar_url}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        title={title || user.full_name}
        loading="lazy"
      />
    )
  }
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.4, background: user.avatar_color }}
      title={title || user.full_name}
    >
      {initials(user.full_name)}
    </span>
  )
}

/** Project logo, or its key on the project colour when no logo is set. */
export function ProjectIcon({ project, size = 38 }) {
  const radius = Math.round(size * 0.27)
  if (project.logo_url) {
    return <img className="project-icon project-logo" src={project.logo_url} alt="" style={{ width: size, height: size, borderRadius: radius }} loading="lazy" />
  }
  return (
    <span className="project-icon" style={{ background: project.color, width: size, height: size, borderRadius: radius, fontSize: Math.max(9, size * 0.34) }}>
      {project.key.slice(0, 3)}
    </span>
  )
}

export function AvatarStack({ users, max = 4, size = 26 }) {
  const shown = users.slice(0, max)
  return (
    <span className="avatar-stack">
      {shown.map((u) => (
        <Avatar key={u.id} user={u} size={size} />
      ))}
      {users.length > max && (
        <span className="avatar avatar-more" style={{ width: size, height: size, fontSize: size * 0.38 }}>
          +{users.length - max}
        </span>
      )}
    </span>
  )
}

export function Badge({ color, children, dot = true }) {
  return (
    <span className="badge" style={{ '--badge': color }}>
      {dot && <i />}
      {children}
    </span>
  )
}

/** Pass the issue: its status label and colour come from its project's workflow. */
export const StatusBadge = ({ status, issue }) => {
  if (issue?.status_label) return <Badge color={issue.status_color}>{issue.status_label}</Badge>
  const s = byKey(STATUSES, status)
  return <Badge color={s.color}>{s.label}</Badge>
}

/** The workflow of a project (falls back to the standard five statuses). */
export const statusesOf = (project) => (project?.statuses?.length ? project.statuses : STATUSES)

export const ProjectStatusBadge = ({ status }) => {
  const s = byKey(PROJECT_STATUSES, status)
  return <Badge color={s.color}>{s.label}</Badge>
}

export function PriorityIcon({ priority, label = false }) {
  const p = byKey(PRIORITIES, priority)
  const Icon = p.icon
  return (
    <span className="icon-label" title={`${p.label} priority`} style={{ color: p.color }}>
      <Icon size={15} strokeWidth={2.5} />
      {label && <span>{p.label}</span>}
    </span>
  )
}

export function TypeIcon({ type, label = false }) {
  const t = byKey(TYPES, type)
  const Icon = t.icon
  return (
    <span className="icon-label" title={t.label} style={{ color: t.color }}>
      <Icon size={15} />
      {label && <span>{t.label}</span>}
    </span>
  )
}

export function Progress({ value, color }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${value}%`, background: color }} />
    </div>
  )
}

export function Empty({ icon: Icon, title, children, action }) {
  return (
    <div className="empty">
      {Icon && (
        <div className="empty-art" aria-hidden="true">
          <svg viewBox="0 0 160 110" width="160" height="110">
            <ellipse cx="80" cy="98" rx="52" ry="7" className="art-shadow" />
            <rect x="34" y="26" width="72" height="50" rx="9" className="art-card back" transform="rotate(-8 70 51)" />
            <rect x="52" y="20" width="72" height="50" rx="9" className="art-card mid" transform="rotate(6 88 45)" />
            <rect x="42" y="30" width="76" height="54" rx="10" className="art-card front" />
            <rect x="52" y="42" width="34" height="5" rx="2.5" className="art-line strong" />
            <rect x="52" y="53" width="56" height="4" rx="2" className="art-line" />
            <rect x="52" y="62" width="44" height="4" rx="2" className="art-line" />
            <circle cx="126" cy="24" r="4" className="art-dot" />
            <circle cx="30" cy="70" r="3" className="art-dot soft" />
            <path d="M22 30l2.2 5 5 2.2-5 2.2-2.2 5-2.2-5-5-2.2 5-2.2z" className="art-spark" />
          </svg>
          <span className="empty-icon"><Icon size={22} /></span>
        </div>
      )}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function Modal({ title, onClose, children, footer, size = 'md' }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal modal-${size}`} role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        {title !== undefined && (
          <div className="modal-header">
            <h2>{title}</h2>
            <button className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        )}
        {children}
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

export function Field({ label, hint, children, as: Tag = 'label' }) {
  return (
    <Tag className="field">
      {label && <span className="label">{label}</span>}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </Tag>
  )
}

export function SortHeader({ label, field, sort, onSort }) {
  const active = sort.field === field
  return (
    <th>
      <button className="th-btn" onClick={() => onSort(field)}>
        {label}
        {active && (sort.dir === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />)}
      </button>
    </th>
  )
}

export function PasswordRules({ password }) {
  const rules = [
    { ok: password.length >= 8, text: 'At least 8 characters' },
    { ok: /[A-Za-z]/.test(password), text: 'Contains a letter' },
    { ok: /\d/.test(password), text: 'Contains a number' },
  ]
  return (
    <ul className="pw-rules">
      {rules.map((r) => (
        <li key={r.text} className={r.ok ? 'ok' : ''}>
          {r.text}
        </li>
      ))}
    </ul>
  )
}

export const passwordValid = (pw) => pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw)

/* ───────────── Day arithmetic (whole days since the epoch, timezone-safe) ───────────── */

export const DAY_MS = 86400000

export function parseDay(iso) {
  if (!iso) return null
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, m - 1, d) / DAY_MS
}

export const dayToISO = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10)

export function todayDay() {
  const now = new Date()
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS
}

export const dayToDate = (day) => new Date(day * DAY_MS) // read with getUTC* methods

/** "in 3 days", "today", "2 days overdue" */
export function relativeDay(iso) {
  const diff = parseDay(iso) - todayDay()
  if (diff === 0) return 'today'
  if (diff === 1) return 'tomorrow'
  if (diff === -1) return 'yesterday'
  return diff > 0 ? `in ${diff} days` : `${-diff} days overdue`
}

/* ───────────── Lifecycle constants ───────────── */

export const PHASES = [
  { key: 'planning', label: 'Planning', hint: 'Scope, requirements and feature list' },
  { key: 'design', label: 'Design', hint: 'Architecture, UX and technical design' },
  { key: 'development', label: 'Development', hint: 'Building the features' },
  { key: 'testing', label: 'Testing', hint: 'QA, bug fixing and acceptance' },
  { key: 'deployment', label: 'Deployment', hint: 'Release preparation and rollout' },
  { key: 'live', label: 'Live', hint: 'In production and being maintained' },
]

export const MILESTONE_STAGES = [
  { key: 'planned', label: 'Planned', color: '#3b82f6' },
  { key: 'design', label: 'Design', color: '#a855f7' },
  { key: 'development', label: 'Development', color: '#f59e0b' },
  { key: 'testing', label: 'Testing', color: '#ec4899' },
  { key: 'deployment', label: 'Deployment', color: '#14b8a6' },
  { key: 'completed', label: 'Completed', color: '#22c55e' },
]

export const FEATURE_STAGES = [
  { key: 'proposed', label: 'Proposed', color: '#94a3b8' },
  { key: 'planned', label: 'Planned', color: '#3b82f6' },
  { key: 'design', label: 'Design', color: '#a855f7' },
  { key: 'development', label: 'Development', color: '#f59e0b' },
  { key: 'testing', label: 'Testing', color: '#ec4899' },
  { key: 'deployment', label: 'Deployment', color: '#14b8a6' },
  { key: 'released', label: 'Released', color: '#22c55e' },
]

export const RELEASE_STATUSES = [
  { key: 'planned', label: 'Planned', color: '#3b82f6' },
  { key: 'in_progress', label: 'In progress', color: '#f59e0b' },
  { key: 'deployed', label: 'Deployed', color: '#22c55e' },
  { key: 'failed', label: 'Failed', color: '#ef4444' },
  { key: 'rolled_back', label: 'Rolled back', color: '#94a3b8' },
]

export const ENVIRONMENTS = [
  { key: 'development', label: 'Development' },
  { key: 'staging', label: 'Staging' },
  { key: 'production', label: 'Production' },
]

export const RECURRENCES = [
  { key: '', label: 'Does not repeat' },
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
]

export const RISK_LEVELS = [
  { key: 'low', label: 'Low', color: '#22c55e' },
  { key: 'medium', label: 'Medium', color: '#f59e0b' },
  { key: 'high', label: 'High', color: '#ef4444' },
]

export const RISK_STATUSES = [
  { key: 'open', label: 'Open', color: '#ef4444' },
  { key: 'mitigating', label: 'Mitigating', color: '#f59e0b' },
  { key: 'occurred', label: 'Occurred', color: '#a855f7' },
  { key: 'closed', label: 'Closed', color: '#94a3b8' },
]

/** Build a CSV file from rows and trigger a download. */
export function downloadCsv(filename, columns, rows) {
  const cell = (value) => {
    const text = value == null ? '' : String(value)
    // Neutralise spreadsheet formulas, then quote.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return `"${safe.replace(/"/g, '""')}"`
  }
  const lines = [columns.map((c) => cell(c.label)).join(',')]
  for (const row of rows) lines.push(columns.map((c) => cell(c.value(row))).join(','))
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/* ───────────── Roles and permissions ───────────── */

export const GLOBAL_ROLES = [
  { key: 'admin', label: 'Administrator', hint: 'Manages users and sees every project' },
  { key: 'manager', label: 'Manager', hint: 'Can create projects and owns the ones they create' },
  { key: 'member', label: 'Member', hint: 'Works only in projects they are added to' },
]

export const PROJECT_ROLES = [
  { key: 'manager', label: 'Manager', color: '#8b5cf6', hint: 'Works like a contributor, and can sign off stages and approve requests' },
  { key: 'contributor', label: 'Contributor', color: '#3b82f6', hint: 'Can create and change work in the sections they can see' },
  { key: 'tester', label: 'Tester', color: '#ec4899', hint: 'Works like a contributor; marks who verifies the work' },
  { key: 'viewer', label: 'Viewer', color: '#94a3b8', hint: 'Read-only in the sections they can see' },
]

export const PROJECT_SECTIONS = [
  { key: 'features', label: 'Features' },
  { key: 'issues', label: 'Issues (Board, List, Timeline)' },
  { key: 'milestones', label: 'Milestones' },
  { key: 'releases', label: 'Releases' },
  { key: 'risks', label: 'Risks' },
  { key: 'docs', label: 'Docs' },
  { key: 'reports', label: 'Reports' },
  { key: 'activity', label: 'Activity' },
]

export const roleLabel = (role) => byKey(GLOBAL_ROLES, role === 'admin' || role === 'manager' ? role : 'member').label

/* ───────────── Loading skeletons ───────────── */

export function Skeleton({ width = '100%', height = 14, radius = 6, style }) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius, ...style }} />
}

/** Placeholder shown while a page loads. variant: 'cards' | 'list' | 'dashboard' | 'project' */
export function PageSkeleton({ variant = 'cards', padded = true }) {
  const card = (key, lines = 3) => (
    <div className="card card-pad stack" key={key} style={{ gap: 12 }}>
      <div className="row"><Skeleton width={38} height={38} radius={10} /><Skeleton width="55%" height={16} /></div>
      {Array.from({ length: lines }, (_, n) => <Skeleton key={n} width={`${90 - n * 18}%`} />)}
    </div>
  )
  const rows = (count) => (
    <div className="card">
      {Array.from({ length: count }, (_, n) => (
        <div className="list-row" key={n} style={{ cursor: 'default' }}>
          <Skeleton width={22} height={22} radius={6} /><Skeleton width={56} /><Skeleton width={`${62 - (n % 3) * 12}%`} /><span className="grow" /><Skeleton width={70} height={20} radius={10} />
        </div>
      ))}
    </div>
  )
  let body
  if (variant === 'list') body = rows(7)
  else if (variant === 'dashboard') {
    body = (
      <>
        <div className="grid grid-stats" style={{ marginBottom: 16 }}>
          {Array.from({ length: 5 }, (_, n) => <div className="card stat" key={n}><Skeleton width="60%" /><Skeleton width={56} height={28} /></div>)}
        </div>
        <div className="grid grid-3" style={{ marginBottom: 16 }}>{[1, 2, 3].map((n) => card(n, 4))}</div>
        {rows(4)}
      </>
    )
  } else if (variant === 'project') {
    body = (
      <>
        <div className="row" style={{ marginBottom: 22, gap: 14 }}><Skeleton width={44} height={44} radius={12} /><div className="stack" style={{ gap: 8, flex: 1 }}><Skeleton width={240} height={22} /><Skeleton width={160} /></div></div>
        <div className="row" style={{ gap: 18, marginBottom: 22 }}>{[70, 80, 60, 90, 70].map((w, n) => <Skeleton key={n} width={w} height={16} />)}</div>
        <div className="grid grid-3">{[1, 2, 3].map((n) => card(n, 4))}</div>
      </>
    )
  } else body = <div className="grid grid-cards">{[1, 2, 3, 4, 5, 6].map((n) => card(n))}</div>
  return (
    <div className={padded ? 'page' : ''} aria-busy="true" aria-label="Loading">
      {padded && variant !== 'project' && <div style={{ marginBottom: 22 }}><Skeleton width={200} height={26} /><Skeleton width={280} style={{ marginTop: 10 }} /></div>}
      {body}
    </div>
  )
}

/* ───────────── Appearance options ───────────── */

export const ACCENTS = [
  { key: '#6366f1', label: 'Indigo' },
  { key: '#8b5cf6', label: 'Violet' },
  { key: '#3b82f6', label: 'Blue' },
  { key: '#0d9488', label: 'Teal' },
  { key: '#16a34a', label: 'Green' },
  { key: '#ea580c', label: 'Orange' },
  { key: '#e11d48', label: 'Rose' },
  { key: '#475569', label: 'Slate' },
]

/** A moment in time as date and time, in the chosen language and time zone. */
export const formatDateTime = (value) => (value ? new Date(value).toLocaleString(localeTag(), withZone({ dateStyle: 'medium', timeStyle: 'short' })) : '')
