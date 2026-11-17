import { useRef, useState } from 'react'
import {
  Bold,
  Code,
  Heading2,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Strikethrough,
  Table,
} from 'lucide-react'
import { uploadImage } from '../api'
import { useToast } from '../context'
import { Avatar, Spinner } from '../ui'

/* ───────────── Rendering ─────────────
   Text is stored as Markdown and turned into React elements here. Nothing is ever injected
   as HTML, so stored text cannot run scripts. */

const INLINE =
  /(!\[[^\]\n]*\]\([^)\s]+\)|\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|\*[^*\s][^*\n]*\*|(?<![\w/])@[a-z0-9._-]{3,50}|https?:\/\/[^\s<)]+)/gi

const safeLink = (url) => /^(https?:\/\/|mailto:|\/(?!\/))/i.test(url)
const safeImage = (url) => /^(https?:\/\/|\/api\/files\/)/i.test(url)

function inline(text, keyBase, mentions) {
  const out = []
  let last = 0
  let n = 0
  for (const match of text.matchAll(INLINE)) {
    const token = match[0]
    const key = `${keyBase}-${n++}`
    let node = null
    if (token.startsWith('![')) {
      const [, alt, url] = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token)
      if (safeImage(url)) node = <img key={key} src={url} alt={alt} loading="lazy" />
    } else if (token.startsWith('[')) {
      const [, label, url] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
      if (safeLink(url)) node = <a key={key} href={url} target="_blank" rel="noopener noreferrer">{label}</a>
    } else if (token.startsWith('**')) node = <strong key={key}>{token.slice(2, -2)}</strong>
    else if (token.startsWith('~~')) node = <del key={key}>{token.slice(2, -2)}</del>
    else if (token.startsWith('`')) node = <code key={key}>{token.slice(1, -1)}</code>
    else if (token.startsWith('*')) node = <em key={key}>{token.slice(1, -1)}</em>
    else if (token.startsWith('@')) {
      const name = token.slice(1).toLowerCase().replace(/[._-]+$/, '')
      if (mentions?.has(name)) {
        out.push(text.slice(last, match.index), <span className="mention" key={key}>@{name}</span>)
        last = match.index + 1 + name.length
        continue
      }
    } else {
      const url = token.replace(/[.,;:!?]+$/, '')
      out.push(text.slice(last, match.index), <a key={key} href={url} target="_blank" rel="noopener noreferrer">{url}</a>)
      last = match.index + url.length
      continue
    }
    if (!node) continue
    out.push(text.slice(last, match.index), node)
    last = match.index + token.length
  }
  out.push(text.slice(last))
  return out
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
const isDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line || '')

export function RichText({ text, members, className = '' }) {
  const mentions = members ? new Set(members.map((m) => m.username.toLowerCase())) : null
  const lines = (text || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  const key = () => blocks.length

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }
    // Fenced code block
    if (/^\s*```/.test(line)) {
      const body = []
      i += 1
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i += 1
      blocks.push(<pre key={key()}><code>{body.join('\n')}</code></pre>)
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const Tag = `h${heading[1].length + 1}`
      blocks.push(<Tag key={key()}>{inline(heading[2], i, mentions)}</Tag>)
      i += 1
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key()} />)
      i += 1
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push(<blockquote key={key()}>{body.map((l, n) => <div key={n}>{inline(l, `q${i}-${n}`, mentions)}</div>)}</blockquote>)
      continue
    }
    // Table: a header row followed by a divider row
    if (line.includes('|') && isDivider(lines[i + 1])) {
      const head = cells(line)
      const rows = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
      blocks.push(
        <div className="md-table" key={key()}>
          <table>
            <thead><tr>{head.map((c, n) => <th key={n}>{inline(c, `th${i}-${n}`, mentions)}</th>)}</tr></thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>{head.map((_, n) => <td key={n}>{inline(row[n] || '', `td${i}-${r}-${n}`, mentions)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    // Lists
    const listKind = (l) => (/^\s*[-*]\s+\[( |x|X)\]\s/.test(l) ? 'task' : /^\s*[-*]\s+/.test(l) ? 'bullet' : /^\s*\d+[.)]\s+/.test(l) ? 'number' : null)
    const kind = listKind(line)
    if (kind) {
      const items = []
      while (i < lines.length && listKind(lines[i]) === kind) {
        const l = lines[i]
        if (kind === 'task') {
          const [, mark, body] = /^\s*[-*]\s+\[( |x|X)\]\s*(.*)$/.exec(l)
          const done = mark !== ' '
          items.push(<li key={i}><input type="checkbox" checked={done} readOnly tabIndex={-1} /> <span className={done ? 'done' : ''}>{inline(body, i, mentions)}</span></li>)
        } else {
          items.push(<li key={i}>{inline(l.replace(/^\s*([-*]|\d+[.)])\s+/, ''), i, mentions)}</li>)
        }
        i += 1
      }
      blocks.push(kind === 'number' ? <ol key={key()}>{items}</ol> : <ul key={key()} className={kind === 'task' ? 'task-list' : ''}>{items}</ul>)
      continue
    }
    // Paragraph: consecutive plain lines
    const body = []
    while (
      i < lines.length && lines[i].trim() && !listKind(lines[i]) &&
      !/^(#{1,3})\s+/.test(lines[i]) && !/^\s*```/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) &&
      !(lines[i].includes('|') && isDivider(lines[i + 1]))
    ) {
      body.push(lines[i++])
    }
    blocks.push(
      <p key={key()}>
        {body.map((l, n) => <span key={n}>{n > 0 && <br />}{inline(l, `p${i}-${n}`, mentions)}</span>)}
      </p>,
    )
  }
  return <div className={`md ${className}`}>{blocks}</div>
}

/* ───────────── Editor ───────────── */

const TOOLS = [
  { key: 'bold', icon: Bold, label: 'Bold (Ctrl+B)', wrap: ['**', '**'], sample: 'bold text' },
  { key: 'italic', icon: Italic, label: 'Italic (Ctrl+I)', wrap: ['*', '*'], sample: 'italic text' },
  { key: 'strike', icon: Strikethrough, label: 'Strikethrough', wrap: ['~~', '~~'], sample: 'text' },
  { key: 'heading', icon: Heading2, label: 'Heading', line: '## ' },
  { key: 'bullet', icon: List, label: 'Bullet list', line: '- ' },
  { key: 'number', icon: ListOrdered, label: 'Numbered list', line: '1. ' },
  { key: 'task', icon: ListChecks, label: 'Task list', line: '- [ ] ' },
  { key: 'quote', icon: Quote, label: 'Quote', line: '> ' },
  { key: 'code', icon: Code, label: 'Code', wrap: ['`', '`'], sample: 'code' },
  { key: 'link', icon: LinkIcon, label: 'Link', wrap: ['[', '](https://)'], sample: 'link text' },
  { key: 'table', icon: Table, label: 'Table', block: '| Column 1 | Column 2 |\n| --- | --- |\n| Text | Text |\n' },
]

/**
 * Text editor with a formatting toolbar, live preview and pasted / dropped images.
 * value is Markdown text; onChange receives the new text.
 */
export function RichEditor({ value, onChange, placeholder, minHeight = 120, autoFocus, members, compact = false, onSubmit }) {
  const toast = useToast()
  const ref = useRef(null)
  const fileRef = useRef(null)
  const [mode, setMode] = useState('write')
  const [uploading, setUploading] = useState(false)
  const [mention, setMention] = useState(null) // { text, start, end }
  const [mentionIndex, setMentionIndex] = useState(0)
  const matches = mention && members
    ? members
        .filter((m) => m.username.toLowerCase().startsWith(mention.text) || m.full_name.toLowerCase().includes(mention.text))
        .sort((a, b) => b.username.toLowerCase().startsWith(mention.text) - a.username.toLowerCase().startsWith(mention.text))
        .slice(0, 6)
    : []

  const pickMention = (member) => {
    const next = `${value.slice(0, mention.start)}@${member.username} ${value.slice(mention.end)}`
    const caret = mention.start + member.username.length + 2
    onChange(next)
    setMention(null)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(caret, caret)
    })
  }

  // Replace the current selection and put the caret / selection where it is useful next.
  const edit = (build) => {
    const el = ref.current
    const start = el.selectionStart
    const end = el.selectionEnd
    const { text, select } = build(value.slice(0, start), value.slice(start, end), value.slice(end))
    onChange(text)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(select[0], select[1])
    })
  }

  const apply = (tool) => {
    if (tool.wrap) {
      edit((before, selected, after) => {
        const inner = selected || tool.sample
        const text = `${before}${tool.wrap[0]}${inner}${tool.wrap[1]}${after}`
        const from = before.length + tool.wrap[0].length
        return { text, select: [from, from + inner.length] }
      })
    } else if (tool.line) {
      edit((before, selected, after) => {
        const lineStart = before.lastIndexOf('\n') + 1
        const head = before.slice(0, lineStart)
        const body = (before.slice(lineStart) + selected).split('\n').map((l) => (l.startsWith(tool.line) ? l : tool.line + l)).join('\n')
        const text = head + body + after
        return { text, select: [head.length + body.length, head.length + body.length] }
      })
    } else if (tool.block) {
      edit((before, selected, after) => {
        const lead = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : ''
        const text = `${before}${lead}${tool.block}${selected}${after}`
        const caret = before.length + lead.length + tool.block.length
        return { text, select: [caret, caret] }
      })
    }
  }

  const insertImages = async (files) => {
    const images = [...files].filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    setUploading(true)
    try {
      for (const file of images) {
        const url = await uploadImage(file)
        edit((before, selected, after) => {
          const lead = before && !before.endsWith('\n') ? '\n' : ''
          const snippet = `${lead}![${(file.name || 'image').replace(/[[\]]/g, '')}](${url})\n`
          const text = before + snippet + after
          return { text, select: [before.length + snippet.length, before.length + snippet.length] }
        })
      }
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setUploading(false)
    }
  }

  const onKeyDown = (e) => {
    if (matches.length) {
      if (e.key === 'ArrowDown') return e.preventDefault(), setMentionIndex((n) => (n + 1) % matches.length)
      if (e.key === 'ArrowUp') return e.preventDefault(), setMentionIndex((n) => (n - 1 + matches.length) % matches.length)
      if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), pickMention(matches[mentionIndex])
      if (e.key === 'Escape') return e.stopPropagation(), setMention(null)
    }
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'b') return e.preventDefault(), apply(TOOLS[0])
    if (mod && e.key.toLowerCase() === 'i') return e.preventDefault(), apply(TOOLS[1])
    if (mod && e.key === 'Enter' && onSubmit) return e.preventDefault(), onSubmit()
    // Continue a list on Enter; an empty item ends it.
    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      const el = e.target
      const before = value.slice(0, el.selectionStart)
      const line = before.slice(before.lastIndexOf('\n') + 1)
      const match = /^(\s*)([-*] \[[ xX]\] |[-*] |(\d+)([.)]) |> )(.*)$/.exec(line)
      if (!match) return undefined
      e.preventDefault()
      if (!match[5]) {
        edit((b, s, after) => {
          const text = b.slice(0, b.length - line.length) + after
          return { text, select: [b.length - line.length, b.length - line.length] }
        })
      } else {
        const marker = match[3] ? `${Number(match[3]) + 1}${match[4]} ` : match[2].replace(/\[[xX]\]/, '[ ]')
        edit((b, s, after) => {
          const insert = `\n${match[1]}${marker}`
          return { text: b + insert + after, select: [b.length + insert.length, b.length + insert.length] }
        })
      }
    }
    return undefined
  }

  return (
    <div className={`rich ${compact ? 'compact' : ''}`} style={{ position: 'relative', overflow: 'visible' }}>
      {matches.length > 0 && (
        <div className="mention-list" role="listbox" style={{ bottom: 'auto', top: '100%', marginTop: 4 }}>
          {matches.map((m, n) => (
            <button
              type="button"
              key={m.id}
              role="option"
              aria-selected={n === mentionIndex}
              className={n === mentionIndex ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault()
                pickMention(m)
              }}
            >
              <Avatar user={m} size={22} />
              <span>{m.full_name}</span>
              <span className="faint small">@{m.username}</span>
            </button>
          ))}
        </div>
      )}
      <div className="rich-bar">
        {TOOLS.map((tool) => (
          <button key={tool.key} type="button" className="rich-tool" title={tool.label} aria-label={tool.label} disabled={mode !== 'write'} onMouseDown={(e) => e.preventDefault()} onClick={() => apply(tool)}>
            <tool.icon size={15} />
          </button>
        ))}
        <button type="button" className="rich-tool" title="Insert image (or paste / drop one)" aria-label="Insert image" disabled={mode !== 'write' || uploading} onMouseDown={(e) => e.preventDefault()} onClick={() => fileRef.current?.click()}>
          {uploading ? <Spinner /> : <ImageIcon size={15} />}
        </button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { insertImages(e.target.files); e.target.value = '' }} />
        <span className="grow" />
        <div className="rich-modes">
          <button type="button" className={mode === 'write' ? 'active' : ''} onClick={() => setMode('write')}>Write</button>
          <button type="button" className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>Preview</button>
        </div>
      </div>
      {mode === 'write' ? (
        <textarea
          ref={ref}
          className="rich-input"
          style={{ minHeight }}
          value={value}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value)
            if (members?.length) {
              const caret = e.target.selectionStart
              const found = /(^|[\s(])@([a-z0-9._-]*)$/i.exec(e.target.value.slice(0, caret))
              setMention(found ? { text: found[2].toLowerCase(), start: caret - found[2].length - 1, end: caret } : null)
              setMentionIndex(0)
            }
          }}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files || [])]
            if (files.some((f) => f.type.startsWith('image/'))) {
              e.preventDefault()
              insertImages(files)
            }
          }}
          onDragOver={(e) => e.dataTransfer?.types?.includes('Files') && e.preventDefault()}
          onDrop={(e) => {
            if (e.dataTransfer?.files?.length) {
              e.preventDefault()
              insertImages(e.dataTransfer.files)
            }
          }}
        />
      ) : (
        <div className="rich-preview" style={{ minHeight }}>
          {value.trim() ? <RichText text={value} members={members} /> : <p className="muted">Nothing to preview yet.</p>}
        </div>
      )}
    </div>
  )
}
