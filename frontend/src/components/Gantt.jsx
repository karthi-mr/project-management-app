import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { dayToDate, dayToISO, formatDate, todayDay } from '../ui'

const SIDE = 280 // width of the sticky label column
const ROW = 40
const ZOOMS = {
  day: { label: 'Day', px: 34 },
  week: { label: 'Week', px: 14 },
  month: { label: 'Month', px: 5 },
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Generic Gantt chart.
 *
 * rows: [{
 *   key, kind: 'group' | 'bar' | 'milestone',
 *   label: ReactNode, title: string (tooltip),
 *   start, end: day numbers (bar span, optional), marker: day number (diamond, optional),
 *   color, progress (0-100), done, draggable, onClick,
 * }]
 * links: [{ from: rowKey, to: rowKey }]  — "from" must finish before "to" starts
 * onReschedule(row, startDay, endDay)
 */
export default function Gantt({ rows, links = [], onReschedule, heading = 'Item', toolbar }) {
  const [zoom, setZoom] = useState('week')
  const [drag, setDrag] = useState(null) // { key, mode, startX, delta, moved }
  const scrollRef = useRef(null)
  const px = ZOOMS[zoom].px
  const today = todayDay()

  const [min, max] = useMemo(() => {
    const days = [today]
    rows.forEach((r) => [r.start, r.end, r.marker].forEach((d) => d != null && days.push(d)))
    let lo = Math.min(...days) - 7
    let hi = Math.max(...days) + 21
    const minSpan = Math.ceil(1100 / px) // always fill a reasonably wide viewport
    if (hi - lo < minSpan) hi = lo + minSpan
    return [lo, hi]
  }, [rows, px, today])

  const total = max - min + 1
  const width = total * px
  const x = (day) => (day - min) * px

  const scrollToToday = (smooth) => {
    scrollRef.current?.scrollTo({ left: Math.max(0, x(today) - 160), behavior: smooth ? 'smooth' : 'auto' })
  }
  // Jump to today on first render and whenever the zoom level changes.
  useLayoutEffect(() => scrollToToday(false), [zoom]) // eslint-disable-line react-hooks/exhaustive-deps

  /* Header segments */
  const months = useMemo(() => {
    const out = []
    let day = min
    while (day <= max) {
      const d = dayToDate(day)
      const y = d.getUTCFullYear()
      const m = d.getUTCMonth()
      const next = Math.min(max + 1, Date.UTC(y, m + 1, 1) / 86400000)
      out.push({ day, span: next - day, label: `${MONTHS[m]} ${y}`, first: d.getUTCDate() === 1 })
      day = next
    }
    return out
  }, [min, max])

  const ticks = useMemo(() => {
    if (zoom === 'month') return []
    const out = []
    for (let day = min; day <= max; day++) {
      const d = dayToDate(day)
      const dow = d.getUTCDay()
      if (zoom === 'day' || dow === 1) out.push({ day, label: d.getUTCDate(), weekend: dow === 0 || dow === 6 })
    }
    return out
  }, [min, max, zoom])

  const weekends = useMemo(() => {
    if (zoom === 'month') return []
    const out = []
    for (let day = min; day <= max; day++) if (dayToDate(day).getUTCDay() === 6) out.push(day)
    return out
  }, [min, max, zoom])

  /* Geometry with the in-flight drag applied */
  const spanOf = (row) => {
    let { start, end } = row
    if (drag && drag.key === row.key && start != null && end != null) {
      if (drag.mode === 'move') {
        start += drag.delta
        end += drag.delta
      } else if (drag.mode === 'end') end = Math.max(start, end + drag.delta)
      else start = Math.min(end, start + drag.delta)
    }
    return { start, end }
  }

  const onPointerDown = (e, row) => {
    if (!row.draggable || !onReschedule || e.button !== 0) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture is a nicety; dragging still works while the pointer stays on the bar */
    }
    setDrag({ key: row.key, mode: e.target.dataset.handle || 'move', startX: e.clientX, delta: 0, moved: false })
  }
  const onPointerMove = (e) => {
    if (!drag) return
    const dx = e.clientX - drag.startX
    const delta = Math.round(dx / px)
    if (delta !== drag.delta || (!drag.moved && Math.abs(dx) > 3)) {
      setDrag({ ...drag, delta, moved: drag.moved || Math.abs(dx) > 3 })
    }
  }
  const onPointerUp = (row) => {
    if (!drag) return
    const { start, end } = spanOf(row)
    const changed = drag.delta !== 0 && (start !== row.start || end !== row.end)
    const wasClick = !drag.moved
    setDrag(null)
    if (changed) onReschedule(row, start, end)
    else if (wasClick) row.onClick?.()
  }

  useEffect(() => {
    if (!drag) return
    const cancel = (e) => e.key === 'Escape' && setDrag(null)
    document.addEventListener('keydown', cancel)
    return () => document.removeEventListener('keydown', cancel)
  }, [drag])

  /* Dependency arrows */
  const index = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows])
  const arrows = links
    .map((link) => {
      const a = rows[index.get(link.from)]
      const b = rows[index.get(link.to)]
      if (!a || !b) return null
      const sa = spanOf(a)
      const sb = spanOf(b)
      if (sa.end == null || sb.start == null) return null
      const x1 = x(sa.end + 1)
      const y1 = index.get(link.from) * ROW + ROW / 2
      const x2 = x(sb.start)
      const y2 = index.get(link.to) * ROW + ROW / 2
      const conflict = sb.start <= sa.end && !a.done
      const out = x1 + 10
      const path =
        x2 - 10 >= out
          ? `M${x1},${y1} H${out} V${y2} H${x2 - 2}`
          : `M${x1},${y1} H${out} V${y2 > y1 ? y2 - ROW / 2 : y2 + ROW / 2} H${x2 - 12} V${y2} H${x2 - 2}`
      return { key: `${link.from}>${link.to}`, path, conflict }
    })
    .filter(Boolean)

  return (
    <div className="card gantt">
      <div className="gantt-toolbar">
        <div className="segmented compact">
          {Object.entries(ZOOMS).map(([key, z]) => (
            <button key={key} type="button" className={zoom === key ? 'active' : ''} onClick={() => setZoom(key)}>
              {z.label}
            </button>
          ))}
        </div>
        <button className="btn btn-sm" onClick={() => scrollToToday(true)}>Today</button>
        <span className="grow" />
        {toolbar}
      </div>

      <div className="gantt-scroll" ref={scrollRef}>
        <div style={{ width: SIDE + width }}>
          <div className="gantt-head">
            <div className="gantt-side gantt-corner" style={{ width: SIDE }}>{heading}</div>
            <div className="gantt-scale" style={{ width }}>
              {months.map((m) => (
                <div key={m.day} className="gantt-month" style={{ left: x(m.day), width: m.span * px }}>
                  <span>{m.span * px > 56 ? m.label : ''}</span>
                </div>
              ))}
              {ticks.map((t) => (
                <div key={t.day} className={`gantt-tick ${t.weekend ? 'weekend' : ''} ${t.day === today ? 'today' : ''}`} style={{ left: x(t.day), width: zoom === 'day' ? px : px * 7, justifyItems: zoom === 'day' ? 'center' : 'start', paddingLeft: zoom === 'day' ? 0 : 3 }}>
                  {t.label}
                </div>
              ))}
            </div>
          </div>

          <div className="gantt-body">
            <div className="gantt-grid" style={{ left: SIDE, width }}>
              {weekends.map((day) => (
                <div key={day} className="gantt-weekend" style={{ left: x(day), width: px * 2 }} />
              ))}
              {months.filter((m) => m.first).map((m) => (
                <div key={m.day} className="gantt-monthline" style={{ left: x(m.day) }} />
              ))}
              <div className="gantt-today" style={{ left: x(today) + px / 2 }} />
            </div>

            {rows.map((row) => {
              const { start, end } = spanOf(row)
              const hasBar = start != null && end != null
              const dragging = drag?.key === row.key && drag.moved
              return (
                <div key={row.key} className={`gantt-row is-${row.kind} ${row.indent ? 'indent' : ''}`} style={{ height: ROW }}>
                  <div
                    className={`gantt-side ${row.onClick ? 'clickable' : ''}`}
                    style={{ width: SIDE }}
                    onClick={row.onClick}
                    title={row.title}
                  >
                    {row.label}
                  </div>
                  <div className="gantt-track" style={{ width }}>
                    {row.kind === 'bar' && hasBar && (
                      <div
                        className={`gantt-bar ${row.done ? 'done' : ''} ${row.draggable && onReschedule ? 'draggable' : ''} ${dragging ? 'dragging' : ''}`}
                        style={{ left: x(start), width: Math.max((end - start + 1) * px, 10), '--bar': row.color }}
                        title={`${row.title || ''}\n${formatDate(dayToISO(start), true)} → ${formatDate(dayToISO(end), true)}`}
                        onPointerDown={(e) => onPointerDown(e, row)}
                        onPointerMove={onPointerMove}
                        onPointerUp={() => onPointerUp(row)}
                        onPointerCancel={() => setDrag(null)}
                        onClick={!(row.draggable && onReschedule) ? row.onClick : undefined}
                      >
                        {row.progress > 0 && <div className="gantt-fill" style={{ width: `${row.progress}%` }} />}
                        {row.draggable && onReschedule && (
                          <>
                            <span className="gantt-handle left" data-handle="start" />
                            <span className="gantt-handle right" data-handle="end" />
                          </>
                        )}
                        {row.done && (end - start + 1) * px > 22 && <Check size={13} strokeWidth={3} />}
                        {dragging && (
                          <span className="gantt-tip">
                            {formatDate(dayToISO(start))} → {formatDate(dayToISO(end))}
                          </span>
                        )}
                      </div>
                    )}
                    {row.kind !== 'bar' && hasBar && (
                      <div className="gantt-summary" style={{ left: x(start), width: Math.max((end - start + 1) * px, 6), '--bar': row.color }} />
                    )}
                    {row.marker != null && (
                      <div
                        className={`gantt-diamond ${row.done ? 'done' : ''}`}
                        style={{ left: x(row.marker) + px / 2, '--bar': row.color }}
                        title={`${row.title || ''}\nDue ${formatDate(dayToISO(row.marker), true)}`}
                        onClick={row.onClick}
                      />
                    )}
                    {!hasBar && row.marker == null && row.kind !== 'group' && (
                      <span className="gantt-unscheduled" style={{ left: Math.max(0, x(today) + px) }}>No dates set</span>
                    )}
                  </div>
                </div>
              )
            })}

            {arrows.length > 0 && (
              <svg className="gantt-links" style={{ left: SIDE }} width={width} height={rows.length * ROW}>
                <defs>
                  <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                    <path d="M0,0 L8,4 L0,8 z" fill="context-stroke" />
                  </marker>
                </defs>
                {arrows.map((a) => (
                  <path key={a.key} d={a.path} className={a.conflict ? 'conflict' : ''} markerEnd="url(#gantt-arrow)" />
                ))}
              </svg>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
