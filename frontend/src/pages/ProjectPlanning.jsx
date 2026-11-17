import { useEffect, useMemo, useState } from 'react'
import { AlarmClock, Boxes, CalendarClock, Check, CircleDot, Flag, GanttChart, Hourglass, Layers, Rocket, Timer } from 'lucide-react'
import { api, notifyChanged } from '../api'
import { useConfirm, useToast } from '../context'
import { PhaseChecklist } from './ProjectExtras'
import { BudgetCard } from './Insights'
import { useFeature, useModule } from '../components/License'
import {
  Avatar,
  Badge,
  ENVIRONMENTS,
  Empty,
  FEATURE_STAGES,
  MILESTONE_STAGES,
  PHASES,
  Progress,
  STATUSES,
  statusesOf,
  TypeIcon,
  byKey,
  dayToISO,
  formatDate,
  parseDay,
  todayDay,
  useOpenIssue,
} from '../ui'
import Gantt from '../components/Gantt'
import DeadlineList from '../components/Deadlines'

const HEALTH = {
  done: { label: 'Completed', color: '#3b82f6', text: 'This project is marked as completed.' },
  overdue: { label: 'Overdue', color: '#ef4444', text: 'The project deadline has passed with work still open.' },
  risk: { label: 'At risk', color: '#f59e0b', text: 'Work is behind schedule, has overdue items or carries a high risk.' },
  track: { label: 'On track', color: '#22c55e', text: 'Progress is keeping pace with the schedule.' },
  unplanned: { label: 'No deadline', color: '#94a3b8', text: 'Set start and due dates in Settings to track schedule health.' },
}

const hours = (n) => `${Math.round(n * 10) / 10}h`

/* ───────────── Overview ───────────── */

/** One level of the lifecycle (milestones, modules or features): how many sit in each stage. */
function StageMix({ icon: Icon, label, items, stages, waiting, onOpen }) {
  const total = items.length
  const counts = stages.map((s) => ({ ...s, count: items.filter((x) => x.stage === s.key).length }))
  return (
    <div className="stage-mix">
      <div className="stage-mix-head">
        <span className="icon-label"><Icon size={15} /> <b>{label}</b> <span className="faint small">{total}</span></span>
        {waiting > 0 && <span className="signoff-wait"><Hourglass size={12} /> {waiting} waiting</span>}
        <button className="btn btn-ghost btn-sm" onClick={onOpen}>Open</button>
      </div>
      {total === 0 ? <div className="faint small">None yet</div> : (
        <>
          <div className="stage-mix-bar" role="img" aria-label={`${label} by stage`}>
            {counts.filter((c) => c.count).map((c) => (
              <span key={c.key} style={{ flex: c.count, background: c.color }} title={`${c.label}: ${c.count}`} />
            ))}
          </div>
          <div className="stage-mix-legend">
            {counts.map((c) => (
              <span key={c.key} className={c.count ? '' : 'faint'}><i style={{ background: c.color }} />{c.label} {c.count}</span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function Overview({ project, issues, milestones, modules = [], features, releases, risks, checks, setTab, reload }) {
  const toast = useToast()
  const confirm = useConfirm()
  const hasBudgets = useFeature('budgets') && useModule('budgets')
  const highRisks = risks.filter((r) => r.severity === 'high' && ['open', 'occurred'].includes(r.status))
  const today = todayDay()
  const phaseIndex = Math.max(0, PHASES.findIndex((p) => p.key === project.phase))
  const nextRelease = releases.find((r) => ['planned', 'in_progress'].includes(r.status))
  const lastDeployed = releases.filter((r) => r.status === 'deployed').sort((a, b) => (b.deployed_at || '').localeCompare(a.deployed_at || ''))[0]

  const setPhase = async (phase) => {
    if (!project.can_manage || phase === project.phase) return
    const target = PHASES.findIndex((p) => p.key === phase)
    const earlier = PHASES.slice(0, target).map((p) => p.key)
    const unfinished = checks.filter((c) => !c.done && earlier.includes(c.phase))
    if (target > phaseIndex && unfinished.length) {
      const ok = await confirm({
        title: `Move to ${PHASES[target].label} with open checklist items?`,
        message: `${unfinished.length} exit criteri${unfinished.length === 1 ? 'on is' : 'a are'} not ticked for earlier phases, for example “${unfinished[0].text}”.`,
        confirmLabel: 'Move anyway',
      })
      if (!ok) return
    }
    try {
      await api(`/projects/${project.id}`, { method: 'PATCH', body: { phase } })
      toast(`Project moved to ${PHASES.find((p) => p.key === phase).label}`)
      reload()
      notifyChanged()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const open = issues.filter((i) => i.status !== 'done')
  const overdueIssues = open.filter((i) => i.due_date && parseDay(i.due_date) < today)
  const estimate = issues.reduce((sum, i) => sum + (i.estimate_hours || 0), 0)
  const spent = issues.reduce((sum, i) => sum + (i.spent_hours || 0), 0)
  const remaining = open.reduce((sum, i) => sum + Math.max(0, (i.estimate_hours || 0) - (i.spent_hours || 0)), 0)

  const start = parseDay(project.start_date)
  const due = parseDay(project.due_date)
  const daysLeft = due != null ? due - today : null
  const elapsed = start != null && due != null && due > start
    ? Math.min(100, Math.max(0, Math.round(((today - start) / (due - start)) * 100)))
    : null

  let health = 'track'
  if (project.status === 'completed') health = 'done'
  else if (daysLeft != null && daysLeft < 0 && open.length > 0) health = 'overdue'
  else if (overdueIssues.length > 0 || highRisks.length > 0 || (elapsed != null && elapsed - project.progress > 20)) health = 'risk'
  else if (due == null) health = 'unplanned'
  const h = HEALTH[health]

  const deadlines = useMemo(() => {
    const base = { project_id: project.id, project_name: project.name, color: project.color }
    const items = [
      ...milestones
        .filter((m) => m.status === 'open' && m.due_date)
        .map((m) => ({ ...base, kind: 'milestone', id: m.id, title: m.name, date: m.due_date, done: false })),
      ...issues
        .filter((i) => i.status !== 'done' && i.due_date)
        .map((i) => ({ ...base, kind: 'issue', id: i.id, key: i.key, title: i.title, date: i.due_date, done: false })),
    ]
    if (project.due_date && project.status !== 'completed') {
      items.push({ ...base, kind: 'project', id: project.id, title: `${project.name} deadline`, date: project.due_date, done: false })
    }
    return items
      .filter((d) => parseDay(d.date) <= today + 30)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 8)
  }, [project, issues, milestones, today])

  const workload = project.members
    .map((m) => {
      const mine = open.filter((i) => i.assignee?.id === m.id)
      return {
        member: m,
        count: mine.length,
        overdue: mine.filter((i) => i.due_date && parseDay(i.due_date) < today).length,
        hours: mine.reduce((sum, i) => sum + Math.max(0, (i.estimate_hours || 0) - (i.spent_hours || 0)), 0),
      }
    })
    .sort((a, b) => b.count - a.count)
  const unassigned = open.filter((i) => !i.assignee).length
  const maxLoad = Math.max(1, ...workload.map((w) => w.count))
  const openMilestones = milestones.filter((m) => m.status === 'open')
  const waiting = [...features, ...modules, ...milestones].filter((x) => x.signoff).length

  return (
    <div className="stack" style={{ gap: 16 }}>
      {project.signoff_gated ? (
        /* The lifecycle is followed on each feature and each milestone, not for the project as a whole. */
        <div className="card">
          <div className="card-header">
            <h2>Lifecycle</h2>
            <span className="small muted">
              {waiting > 0 ? `${waiting} sign-off ${waiting === 1 ? 'request is' : 'requests are'} waiting for the owner or a manager` : 'No sign-off is waiting'}
            </span>
          </div>
          <div className="card-body stack" style={{ gap: 14 }}>
            <p className="small muted" style={{ margin: 0 }}>
              Milestones hold modules, modules hold features. Every stage is signed off; a module and a milestone move on when all their features are signed off.
            </p>
            <StageMix icon={Flag} label="Milestones" items={milestones} stages={MILESTONE_STAGES} waiting={milestones.filter((x) => x.signoff).length} onOpen={() => setTab('milestones')} />
            <StageMix icon={Boxes} label="Modules" items={modules} stages={FEATURE_STAGES} waiting={modules.filter((x) => x.signoff).length} onOpen={() => setTab('modules')} />
            <StageMix icon={Layers} label="Features" items={features} stages={FEATURE_STAGES} waiting={features.filter((x) => x.signoff).length} onOpen={() => setTab('features')} />
          </div>
        </div>
      ) : (
        <>
        <div className="card">
          <div className="card-header">
            <h2>Project lifecycle</h2>
            <span className="small muted">{PHASES[phaseIndex].hint}{project.can_manage && ' · click a phase to move the project'}</span>
          </div>
          <div className="card-body">
            <div className="stepper">
              {PHASES.map((p, n) => (
                <button
                  key={p.key}
                  type="button"
                  className={`step ${n < phaseIndex ? 'done' : n === phaseIndex ? 'current' : ''} ${project.can_manage ? 'clickable' : ''}`}
                  style={{ '--c': project.color }}
                  onClick={() => setPhase(p.key)}
                  title={p.hint}
                  aria-current={n === phaseIndex ? 'step' : undefined}
                >
                  <span className="step-dot">{n < phaseIndex ? <Check size={15} strokeWidth={3} /> : n + 1}</span>
                  <span className="step-label">{p.label}</span>
                  {checks.some((c) => c.phase === p.key) && (
                    <span className="step-count">{checks.filter((c) => c.phase === p.key && c.done).length}/{checks.filter((c) => c.phase === p.key).length} checks</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        <PhaseChecklist project={project} checks={checks} reload={reload} />
        </>
      )}
      {project.can_manage && hasBudgets && <BudgetCard project={project} reload={reload} />}

      <div className="grid grid-2">
        <div className="card">
          <div className="card-header">
            <h2>Features</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setTab('features')}><Layers size={14} /> Manage</button>
          </div>
          <div className="card-body">
            {features.length === 0 ? (
              <p className="muted">No features yet. List what this project will deliver to track it from plan to release.</p>
            ) : (
              <>
                <div className="stacked">
                  {FEATURE_STAGES.map((s) => {
                    const count = features.filter((f) => f.stage === s.key).length
                    return count ? <div key={s.key} style={{ flex: count, background: s.color }} title={`${s.label}: ${count}`} /> : null
                  })}
                </div>
                <div className="legend" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
                  {FEATURE_STAGES.map((s) => (
                    <div className="legend-item" key={s.key}><i style={{ background: s.color }} />{s.label}<b>{features.filter((f) => f.stage === s.key).length}</b></div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h2>Deployment</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setTab('releases')}><Rocket size={14} /> Releases</button>
          </div>
          <div className="card-body stack" style={{ gap: 10 }}>
            <div className="row between">
              <span className="muted">Next release</span>
              {nextRelease ? (
                <span><b>{nextRelease.version}</b> <span className="muted">to {ENVIRONMENTS.find((e) => e.key === nextRelease.environment).label.toLowerCase()}{nextRelease.planned_date && ` · ${formatDate(nextRelease.planned_date)}`}</span></span>
              ) : <span className="faint">Nothing planned</span>}
            </div>
            <div className="row between">
              <span className="muted">Last deployed</span>
              {lastDeployed ? (
                <span><b>{lastDeployed.version}</b> <span className="muted">to {ENVIRONMENTS.find((e) => e.key === lastDeployed.environment).label.toLowerCase()} · {formatDate(lastDeployed.deployed_at)}</span></span>
              ) : <span className="faint">Not deployed yet</span>}
            </div>
            <div className="row between">
              <span className="muted">Features released</span>
              <b>{features.filter((f) => f.stage === 'released').length} of {features.length}</b>
            </div>
          </div>
        </div>
      </div>

      <div className="card card-pad row row-wrap" style={{ gap: 22 }}>
        <div className="ring" style={{ '--p': project.progress, '--c': project.color }}>
          <b>{project.progress}%</b>
        </div>
        <div className="grow" style={{ minWidth: 240 }}>
          <div className="row row-wrap" style={{ marginBottom: 4 }}>
            <h2>Project health</h2>
            <Badge color={h.color}>{h.label}</Badge>
          </div>
          <p className="muted">{h.text}{highRisks.length > 0 && <> <a href="#" onClick={(e) => { e.preventDefault(); setTab('risks') }}>{highRisks.length} high risk{highRisks.length === 1 ? '' : 's'} open.</a></>}</p>
          {project.description && <p style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{project.description}</p>}
          {elapsed != null && (
            <div className="grid grid-2" style={{ marginTop: 14, gap: 18 }}>
              <div>
                <div className="row between small muted" style={{ marginBottom: 5 }}><span>Time elapsed</span><b>{elapsed}%</b></div>
                <Progress value={elapsed} color="var(--text-3)" />
              </div>
              <div>
                <div className="row between small muted" style={{ marginBottom: 5 }}><span>Work completed</span><b>{project.progress}%</b></div>
                <Progress value={project.progress} color={project.color} />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        <div className="card stat">
          <div className="stat-top">{daysLeft != null && daysLeft < 0 ? 'Days overdue' : 'Days remaining'}<span className="stat-icon" style={{ '--c': daysLeft != null && daysLeft < 0 ? '#ef4444' : '#6366f1' }}><CalendarClock size={17} /></span></div>
          <div className="stat-value">{daysLeft == null ? '—' : Math.abs(daysLeft)}</div>
          <div className="small faint">{project.due_date ? `Due ${formatDate(project.due_date, true)}` : 'No deadline set'}</div>
        </div>
        <div className="card stat">
          <div className="stat-top">Open issues<span className="stat-icon" style={{ '--c': '#3b82f6' }}><CircleDot size={17} /></span></div>
          <div className="stat-value">{open.length}</div>
          <div className="small faint">{project.done_count} of {project.issue_count} done</div>
        </div>
        <div className="card stat">
          <div className="stat-top">Overdue issues<span className="stat-icon" style={{ '--c': '#ef4444' }}><AlarmClock size={17} /></span></div>
          <div className="stat-value">{overdueIssues.length}</div>
          <div className="small faint">{overdueIssues.length ? 'Need attention' : 'Nothing late'}</div>
        </div>
        <div className="card stat">
          <div className="stat-top">Time logged<span className="stat-icon" style={{ '--c': '#a855f7' }}><Timer size={17} /></span></div>
          <div className="stat-value">{hours(spent)}</div>
          <div className="small faint">{estimate ? `of ${hours(estimate)} estimated` : 'No estimates yet'}</div>
        </div>
        <div className="card stat">
          <div className="stat-top">Work remaining<span className="stat-icon" style={{ '--c': '#f59e0b' }}><Hourglass size={17} /></span></div>
          <div className="stat-value">{hours(remaining)}</div>
          <div className="small faint">Estimate minus time logged</div>
        </div>
      </div>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-header">
            <h2>Upcoming deadlines</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setTab('timeline')}><GanttChart size={14} /> Timeline</button>
          </div>
          <div className="card-body">
            {deadlines.length === 0 ? (
              <p className="muted">Nothing is due in the next 30 days. Add due dates to issues and milestones to see them here.</p>
            ) : (
              <DeadlineList items={deadlines} showProject={false} />
            )}
          </div>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header"><h2>Team workload</h2><span className="faint small">Open issues</span></div>
            <div className="card-body">
              {workload.map((w) => (
                <div className="work-row" key={w.member.id}>
                  <span className="row truncate" style={{ gap: 8 }}><Avatar user={w.member} size={24} /><span className="truncate">{w.member.full_name}</span></span>
                  <Progress value={(w.count / maxLoad) * 100} color={w.overdue ? '#ef4444' : project.color} />
                  <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
                    <b style={{ color: 'var(--text)' }}>{w.count}</b>{w.hours > 0 && ` · ${hours(w.hours)}`}{w.overdue > 0 && <span className="danger-text"> · {w.overdue} late</span>}
                  </span>
                </div>
              ))}
              {unassigned > 0 && <p className="small muted" style={{ marginTop: 12 }}>{unassigned} open issue{unassigned === 1 ? ' is' : 's are'} unassigned.</p>}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h2>Milestones</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setTab('milestones')}>Manage</button>
            </div>
            <div className="card-body stack">
              {openMilestones.length === 0 && <p className="muted">No open milestones. Use milestones to break the project into phases or releases.</p>}
              {openMilestones.map((m) => (
                <div key={m.id}>
                  <div className="row between" style={{ marginBottom: 6 }}>
                    <span className="row truncate" style={{ gap: 7 }}><Flag size={14} color={project.color} /><b className="truncate">{m.name}</b></span>
                    <span className={`small ${m.due_date && parseDay(m.due_date) < today ? 'danger-text' : 'muted'}`} style={{ whiteSpace: 'nowrap' }}>
                      {m.due_date ? `Due ${formatDate(m.due_date)}` : 'No date'} · {m.progress}%
                    </span>
                  </div>
                  <Progress value={m.progress} color={project.color} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ───────────── Timeline (Gantt) ───────────── */

/* The plan as a Gantt chart, nested the way the project is: milestone → modules → features → issues. */
export function ProjectTimeline({ project, issues, milestones, modules = [], features, onCreate, onOpenFeature }) {
  const openIssue = useOpenIssue()
  const toast = useToast()
  const [hideDone, setHideDone] = useState(false)
  const [pending, setPending] = useState({}) // optimistic dates until the reload lands

  useEffect(() => setPending({}), [issues])

  const { rows, links } = useMemo(() => {
    const visible = issues.filter((i) => !(hideDone && i.status === 'done'))
    const span = (i) => {
      const p = pending[i.id]
      const start = p ? p.start : parseDay(i.start_date ?? i.due_date)
      const end = p ? p.end : parseDay(i.due_date ?? i.start_date)
      return { start, end }
    }
    const issueRow = (i, depth) => {
      const { start, end } = span(i)
      return {
        key: `i-${i.id}`,
        issue: i,
        kind: 'bar',
        depth,
        start,
        end,
        color: i.status_color || byKey(STATUSES, i.status).color,
        done: i.status === 'done',
        draggable: true,
        title: `${i.key} · ${i.title}`,
        onClick: () => openIssue(i.id),
        label: (
          <>
            <TypeIcon type={i.type} />
            <span className="issue-key">{i.key}</span>
            <span className="truncate grow" style={i.status === 'done' ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>{i.title}</span>
            <Avatar user={i.assignee} size={20} />
          </>
        ),
      }
    }
    const byStart = (a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.issue.id - b.issue.id
    const issuesFor = (match, depth) => visible.filter(match).map((i) => issueRow(i, depth)).sort(byStart)

    // A summary row spans its own dates and everything under it.
    const group = ({ key, depth, Icon, name, start, marker, done, note, onClick }, children) => {
      const starts = children.map((c) => c.start).filter((d) => d != null)
      const ends = children.map((c) => c.end).filter((d) => d != null)
      if (start != null) starts.push(start)
      if (marker != null) ends.push(marker)
      const known = starts.length && ends.length
      return {
        key, kind: 'group', depth, marker, done, title: name, onClick,
        start: known ? Math.min(...starts) : null,
        end: known ? Math.max(...ends) : null,
        color: project.color,
        label: (
          <>
            <Icon size={14} color={project.color} />
            <span className="truncate grow">{name}</span>
            {note && <span className="faint small" style={{ fontWeight: 500 }}>{note}</span>}
          </>
        ),
      }
    }
    const stageLabel = (stage) => byKey(FEATURE_STAGES, stage).label

    // Feature → its issues.
    const featureBlock = (f, depth) => {
      const children = issuesFor((i) => i.feature_id === f.id, depth + 1)
      if (hideDone && f.stage === 'released' && children.length === 0) return []
      const row = group({
        key: `f-${f.id}`, depth, Icon: Layers, name: f.title, start: parseDay(f.start_date), marker: parseDay(f.target_date),
        done: f.stage === 'released', note: stageLabel(f.stage), onClick: onOpenFeature ? () => onOpenFeature(f.id) : undefined,
      }, children)
      return [row, ...children]
    }
    // Module → its features → their issues.
    const moduleBlock = (mod, depth) => {
      const blocks = features.filter((f) => f.module_id === mod.id).map((f) => featureBlock(f, depth + 1))
      if (hideDone && mod.stage === 'released' && blocks.every((b) => b.length === 0)) return []
      const row = group({
        key: `md-${mod.id}`, depth, Icon: Boxes, name: mod.name, start: parseDay(mod.start_date), marker: parseDay(mod.target_date),
        done: mod.stage === 'released', note: stageLabel(mod.stage),
      }, blocks.filter((b) => b.length).map((b) => b[0]))
      return [row, ...blocks.flat()]
    }

    const featureIds = new Set(features.map((f) => f.id))
    const out = []
    // Milestone → its modules → features of its own → issues of its own.
    for (const m of milestones) {
      if (hideDone && m.status === 'closed') continue
      const blocks = [
        ...modules.filter((mod) => mod.milestone_id === m.id).map((mod) => moduleBlock(mod, 1)),
        ...features.filter((f) => f.milestone_id === m.id && !f.module_id).map((f) => featureBlock(f, 1)),
      ].filter((b) => b.length)
      const loose = issuesFor((i) => i.milestone_id === m.id && !(i.feature_id && featureIds.has(i.feature_id)), 1)
      const row = group({
        key: `m-${m.id}`, depth: 0, Icon: Flag, name: m.name, start: parseDay(m.start_date), marker: parseDay(m.due_date),
        done: m.status === 'closed', note: `${m.progress}%`,
      }, [...blocks.map((b) => b[0]), ...loose])
      out.push(row, ...blocks.flat(), ...loose)
    }
    // Everything that is not in a milestone.
    const milestoneIds = new Set(milestones.map((m) => m.id))
    const rest = [
      ...modules.filter((mod) => !mod.milestone_id || !milestoneIds.has(mod.milestone_id)).map((mod) => moduleBlock(mod, 1)),
      ...features.filter((f) => !f.module_id && (!f.milestone_id || !milestoneIds.has(f.milestone_id))).map((f) => featureBlock(f, 1)),
    ].filter((b) => b.length)
    const restIssues = issuesFor((i) => !(i.feature_id && featureIds.has(i.feature_id)) && !(i.milestone_id && milestoneIds.has(i.milestone_id)), 1)
    if (rest.length || restIssues.length) {
      if (out.length) out.push({ key: 'g-none', kind: 'group', depth: 0, label: <span className="muted">Not in a milestone</span> })
      const depth = out.length ? 0 : -1
      const shift = (r) => ({ ...r, depth: r.depth + depth })
      out.push(...rest.flat().map(shift), ...restIssues.map(shift))
    }

    const present = new Set(out.map((r) => r.key))
    const deps = []
    for (const i of visible) {
      for (const b of i.blocked_by) {
        if (present.has(`i-${b.id}`) && present.has(`i-${i.id}`)) deps.push({ from: `i-${b.id}`, to: `i-${i.id}` })
      }
    }
    return { rows: out, links: deps }
  }, [issues, milestones, modules, features, hideDone, pending, project.color]) // eslint-disable-line react-hooks/exhaustive-deps

  const reschedule = async (row, start, end) => {
    const id = row.issue.id
    setPending((p) => ({ ...p, [id]: { start, end } }))
    try {
      await api(`/issues/${id}`, { method: 'PATCH', body: { start_date: dayToISO(start), due_date: dayToISO(end) } })
      notifyChanged()
    } catch (err) {
      setPending((p) => {
        const next = { ...p }
        delete next[id]
        return next
      })
      toast(err.message, 'error')
    }
  }

  if (issues.length === 0 && milestones.length === 0 && features.length === 0) {
    return (
      <div className="card">
        <Empty icon={GanttChart} title="Nothing to plan yet" action={<button className="btn btn-primary" onClick={onCreate}>New issue</button>}>
          Create issues with start and due dates, and milestones for key deliverables. They appear here as a Gantt chart.
        </Empty>
      </div>
    )
  }

  const unscheduled = rows.filter((r) => r.kind === 'bar' && r.start == null).length

  return (
    <div className="stack">
      <Gantt
        rows={rows}
        links={links}
        onReschedule={reschedule}
        heading="Milestones › modules › features › issues"
        toolbar={
          <>
            <span className="gantt-legend hide-mobile">
              {statusesOf(project).map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
              <span><i className="diamond" style={{ background: project.color }} />Milestone</span>
            </span>
            <label className="check-item small">
              <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide completed
            </label>
          </>
        }
      />
      <p className="small muted">
        Drag a bar to move it, or drag its edges to change the start or due date. Arrows show dependencies (set “Blocked by” on an issue);
        a red arrow means the issue is scheduled to start before its blocker finishes.
        {unscheduled > 0 && ` ${unscheduled} issue${unscheduled === 1 ? ' has' : 's have'} no dates yet — open one to schedule it.`}
      </p>
    </div>
  )
}
