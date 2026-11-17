import { useNavigate } from 'react-router-dom'
import { Building2, CheckSquare, CreditCard, Flag, KeyRound, Layers, Rocket, ShieldAlert, Stamp, Target } from 'lucide-react'
import { dayToDate, parseDay, relativeDay, todayDay, useOpenIssue } from '../ui'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const KIND_META = {
  project: { label: 'Project deadline', icon: Target },
  milestone: { label: 'Milestone', icon: Flag },
  feature: { label: 'Feature', icon: Layers },
  release: { label: 'Release', icon: Rocket },
  issue: { label: 'Issue', icon: CheckSquare },
  risk: { label: 'Risk', icon: ShieldAlert },
  approval: { label: 'Approval', icon: Stamp },
  reset: { label: 'Administration', icon: KeyRound },
  license: { label: 'License', icon: CreditCard },
  platform: { label: 'Owner console', icon: Building2 },
}

/** Shared click behaviour for a schedule item ({kind, id, project_id, ...}). */
export function useOpenDeadline() {
  const openIssue = useOpenIssue()
  const navigate = useNavigate()
  return (item) => {
    if (item.kind === 'issue') openIssue(item.id)
    else if (item.kind === 'milestone') navigate(`/projects/${item.project_id}?tab=milestones`)
    else if (item.kind === 'feature') navigate(`/projects/${item.project_id}?tab=features&feature=${item.id}`)
    else if (item.kind === 'release') navigate(`/projects/${item.project_id}?tab=releases`)
    else if (item.kind === 'risk') navigate(`/projects/${item.project_id}?tab=risks`)
    else if (item.kind === 'approval') navigate(`/projects/${item.project_id}?tab=approvals`)
    else if (item.kind === 'reset') navigate('/users?tab=requests')
    else if (item.kind === 'license') navigate('/billing')
    else if (item.kind === 'platform') navigate('/platform?tab=requests')
    else navigate(`/projects/${item.project_id}`)
  }
}

export function KindIcon({ kind, color }) {
  const Icon = KIND_META[kind].icon
  return (
    <span className="kind-icon" style={{ '--c': color }} title={KIND_META[kind].label}>
      <Icon size={12} strokeWidth={2.5} />
    </span>
  )
}

/** List of deadlines: items are {kind, id, title, date, done, project_id, project_name, color, key?}. */
export default function DeadlineList({ items, showProject = true }) {
  const open = useOpenDeadline()
  const today = todayDay()
  return (
    <div>
      {items.map((item) => {
        const day = parseDay(item.date)
        const date = dayToDate(day)
        const overdue = day < today && !item.done
        return (
          <button className="deadline-row" key={`${item.kind}-${item.id}`} onClick={() => open(item)}>
            <span className={`deadline-date ${overdue ? 'overdue' : ''}`}>
              <span>{MONTHS[date.getUTCMonth()]}</span>
              <b>{date.getUTCDate()}</b>
            </span>
            <span className="grow">
              <span className="row" style={{ gap: 7 }}>
                <KindIcon kind={item.kind} color={item.color} />
                <span className="deadline-title truncate" style={item.done ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>
                  {item.key && <span className="issue-key">{item.key} </span>}
                  {item.title}
                </span>
              </span>
              <span className="small faint">
                {showProject && item.kind !== 'project' && `${item.project_name} · `}
                {KIND_META[item.kind].label}
              </span>
            </span>
            <span className={`small ${overdue ? 'danger-text' : 'muted'}`} style={{ whiteSpace: 'nowrap', fontWeight: overdue ? 600 : 400 }}>
              {item.done ? 'Done' : relativeDay(item.date)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
