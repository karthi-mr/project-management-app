import { SIGNOFF_MODES } from '../ui'

/** Three cards: off, simple, strict. */
export default function SignoffModePicker({ value, onChange, disabled, strictLocked = false }) {
  return (
    <div className="mode-picker" role="radiogroup" aria-label="Stage sign-off">
      {SIGNOFF_MODES.map((m) => {
        // Strict request-and-approve comes with the Approvals Pro add-on (or a plan that includes it).
        const locked = m.key === 'strict' && strictLocked && value !== 'strict'
        return (
          <button
            key={m.key}
            type="button"
            role="radio"
            aria-checked={value === m.key}
            className={`mode-card ${value === m.key ? 'active' : ''} ${locked ? 'locked' : ''}`}
            onClick={() => !disabled && !locked && onChange(m.key)}
            disabled={disabled || locked}
            title={locked ? 'Needs the Approvals Pro add-on' : undefined}
          >
            <b>{m.label}{m.key === 'simple' ? ' (recommended)' : ''}</b>
            <span>{locked ? 'Needs the Approvals Pro add-on.' : m.hint}</span>
          </button>
        )
      })}
    </div>
  )
}
