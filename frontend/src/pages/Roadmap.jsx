import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Flag, GanttChart } from 'lucide-react'
import { api, notifyChanged, onChanged } from '../api'
import { useToast } from '../context'
import { Empty, ProjectStatusBadge, Spinner, dayToISO, parseDay, PageSkeleton } from '../ui'
import Gantt from '../components/Gantt'

export default function Roadmap() {
  const navigate = useNavigate()
  const toast = useToast()
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState('')
  const [hideDone, setHideDone] = useState(false)
  const [pending, setPending] = useState({})

  useEffect(() => {
    const load = () =>
      api('/roadmap')
        .then((data) => {
          setProjects(data)
          setPending({})
        })
        .catch((e) => setError(e.message))
    load()
    return onChanged(load)
  }, [])

  const rows = useMemo(() => {
    if (!projects) return []
    const out = []
    for (const p of projects) {
      if (hideDone && p.status === 'completed') continue
      const milestoneDays = p.milestones.map((m) => parseDay(m.due_date)).filter((d) => d != null)
      const override = pending[p.id]
      const start = override ? override.start : parseDay(p.start_date ?? p.created_at)
      let end = override ? override.end : parseDay(p.due_date)
      if (end == null && milestoneDays.length) end = Math.max(...milestoneDays)
      const scheduled = end != null && end >= start
      out.push({
        key: `p-${p.id}`,
        project: p,
        kind: 'bar',
        start: scheduled ? start : null,
        end: scheduled ? end : null,
        color: p.color,
        progress: p.progress,
        done: p.status === 'completed',
        draggable: Boolean(p.can_manage && p.start_date && p.due_date),
        title: `${p.name} · ${p.progress}% complete`,
        onClick: () => navigate(`/projects/${p.id}?tab=timeline`),
        label: (
          <>
            <span className="nav-dot" style={{ background: p.color, margin: 0 }} />
            <b className="truncate grow">{p.name}</b>
            <span className="faint small">{p.progress}%</span>
          </>
        ),
      })
      for (const m of p.milestones) {
        if (hideDone && m.status === 'closed') continue
        const due = parseDay(m.due_date)
        const mStart = parseDay(m.start_date)
        out.push({
          key: `m-${m.id}`,
          kind: 'milestone',
          indent: true,
          start: mStart != null && due != null ? mStart : null,
          end: mStart != null && due != null ? due : null,
          marker: due,
          color: p.color,
          done: m.status === 'closed',
          title: `${m.name} · ${m.progress}% complete`,
          onClick: () => navigate(`/projects/${p.id}?tab=milestones`),
          label: (
            <>
              <Flag size={13} color={p.color} />
              <span className="truncate grow muted">{m.name}</span>
              <span className="faint small">{m.progress}%</span>
            </>
          ),
        })
      }
    }
    return out
  }, [projects, hideDone, pending, navigate])

  const reschedule = async (row, start, end) => {
    const id = row.project.id
    setPending((p) => ({ ...p, [id]: { start, end } }))
    try {
      await api(`/projects/${id}`, { method: 'PATCH', body: { start_date: dayToISO(start), due_date: dayToISO(end) } })
      notifyChanged()
    } catch (err) {
      setPending({})
      toast(err.message, 'error')
    }
  }

  if (error) return <div className="page"><div className="form-error">{error}</div></div>
  if (!projects) return <PageSkeleton variant="cards" />

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Roadmap</h1>
          <p>Every project and milestone on one timeline.</p>
        </div>
      </div>
      {projects.length === 0 ? (
        <div className="card">
          <Empty icon={GanttChart} title="No projects to show" action={<Link className="btn btn-primary" to="/projects">Go to projects</Link>}>
            Create a project with a start and due date to see it on the roadmap.
          </Empty>
        </div>
      ) : (
        <div className="stack">
          <Gantt
            rows={rows}
            onReschedule={reschedule}
            heading="Projects and milestones"
            toolbar={
              <>
                <span className="row hide-mobile" style={{ gap: 6 }}>
                  {[...new Set(projects.map((p) => p.status))].map((s) => <ProjectStatusBadge key={s} status={s} />)}
                </span>
                <label className="check-item small">
                  <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide completed
                </label>
              </>
            }
          />
          <p className="small muted">
            The filled part of each bar is the share of issues completed. Diamonds are milestone due dates. Projects you manage that have both a
            start and a due date can be dragged to reschedule; projects without a due date run to their last milestone.
          </p>
        </div>
      )}
    </div>
  )
}
