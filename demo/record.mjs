/* Records the Trackly demo walkthrough.
 *
 * Starts the app on a throwaway database (never your real data), fills a fictional company with
 * realistic work, then drives Chromium scene by scene. Frames are captured with the DevTools
 * screencast (sharper than Playwright's own video) and each scene lasts as long as its voice line.
 *
 * Output: build/frames/*.jpg, build/frames.json (file + time) and build/timeline.json (scene starts).
 * Run from the repository root:  node demo/record.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, '../frontend/package.json'))
const { chromium, request: apiRequest } = require('@playwright/test')

const PORT = 8811
const BASE = `http://127.0.0.1:${PORT}`
const BUILD = path.join(here, 'build')
const FRAMES = path.join(BUILD, 'frames')
const script = JSON.parse(fs.readFileSync(path.join(here, 'script.json'), 'utf8'))
const voice = JSON.parse(fs.readFileSync(path.join(BUILD, 'voice.json'), 'utf8')) // id -> seconds
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ───────────── The app on a throwaway database ───────────── */

async function startServer() {
  const server = spawn('sh', [path.join(here, '../frontend/e2e/serve.sh')], {
    env: { ...process.env, E2E_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return server
    } catch { /* still starting */ }
    await sleep(500)
  }
  server.kill()
  throw new Error('The app did not start')
}

/* ───────────── Demo data: a fictional company ───────────── */

async function seed() {
  const api = await apiRequest.newContext({ baseURL: BASE, userAgent: UA })
  const call = async (token, method, url, data) => {
    const res = await api.fetch(url, { method, data, headers: token ? { Authorization: `Bearer ${token}` } : {} })
    const text = await res.text()
    if (!res.ok()) throw new Error(`${method} ${url} -> ${res.status()}: ${text}`)
    return text ? JSON.parse(text) : null
  }
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)

  const owner = await call(null, 'POST', '/api/auth/register', {
    company: 'Northwind Retail', full_name: 'Priya Sharma', email: 'priya@northwind.example', username: 'priya',
    password: 'Demo#Pass123', accept_terms: true,
  })
  const T = owner.access_token
  const workspace = owner.user.org.public_id
  const person = async (username, full_name, role = 'member') => {
    const created = await call(T, 'POST', '/api/users', { username, full_name, email: `${username}@northwind.example`, role, password: 'Temp#Pass123' })
    const first = await call(null, 'POST', '/api/auth/login', { workspace, username, password: 'Temp#Pass123' })
    const changed = await call(first.access_token, 'POST', '/api/auth/change-password', { current_password: 'Temp#Pass123', new_password: 'Demo#Pass123' })
    return { id: created.user.id, token: changed.access_token }
  }
  const arjun = await person('arjun', 'Arjun Mehta', 'manager')
  const dana = await person('dana', 'Dana Lee')
  const sam = await person('sam', 'Sam Carter')
  const meera = await person('meera', 'Meera Iyer')

  // The example project from sign-up goes to the recycle bin; the demo has its own.
  for (const p of await call(T, 'GET', '/api/projects')) await call(T, 'DELETE', `/api/projects/${p.id}`)

  const project = async (name, key, color, days, extra = {}) =>
    call(T, 'POST', '/api/projects', { name, key, color, start_date: day(-30), due_date: day(days), signoff_mode: 'off', ...extra })
  const app = await project('Mobile App 2.0', 'APP', '#6366f1', 60, { description: 'The new shopping app for iOS and Android.' })
  const store = await project('Store Redesign', 'STR', '#0ea5e9', 90)
  const loyalty = await project('Loyalty Program', 'LOY', '#f59e0b', 40)
  for (const p of [app, store, loyalty]) {
    await call(T, 'POST', `/api/projects/${p.id}/members`, { user_id: arjun.id, role: 'manager' })
    await call(T, 'POST', `/api/projects/${p.id}/members`, { user_id: dana.id, role: 'contributor' })
    await call(T, 'POST', `/api/projects/${p.id}/members`, { user_id: sam.id, role: 'tester' })
    await call(T, 'POST', `/api/projects/${p.id}/members`, { user_id: meera.id, role: 'contributor' })
  }

  const milestone = (p, name, start, due) => call(T, 'POST', `/api/projects/${p.id}/milestones`, { name, start_date: day(start), due_date: day(due) })
  const beta = await milestone(app, 'Beta release', -20, 12)
  const launch = await milestone(app, 'Public launch', 5, 45)
  await milestone(store, 'Concepts approved', -10, 15)
  await milestone(store, 'Pilot store opens', 20, 80)
  await milestone(loyalty, 'Rewards go live', -5, 35)

  const feature = (p, title, stage, priority, owner_id, milestone_id, start, target) =>
    call(T, 'POST', `/api/projects/${p.id}/features`, { title, stage, priority, owner_id, milestone_id, start_date: day(start), target_date: day(target) })
  const checkout = await feature(app, 'Checkout with UPI', 'development', 'high', dana.id, beta.id, -18, 6)
  await feature(app, 'Order tracking', 'testing', 'high', meera.id, beta.id, -20, 4)
  const push = await feature(app, 'Push notifications', 'design', 'medium', dana.id, launch.id, -6, 25)
  await feature(app, 'Wishlist', 'planned', 'medium', meera.id, launch.id, 5, 35)
  await feature(app, 'Product reviews', 'proposed', 'low', null, null, 15, 45)
  await feature(store, 'Self-checkout kiosks', 'design', 'high', arjun.id, null, -5, 30)
  await feature(loyalty, 'Points wallet', 'development', 'high', meera.id, null, -12, 20)

  const issues = [
    [app, 'Integrate UPI payment SDK', 'story', 'in_progress', 'high', dana, 3, checkout.id],
    [app, 'Payment fails on slow networks', 'bug', 'todo', 'urgent', dana, 2, checkout.id],
    [app, 'Order status timeline screen', 'task', 'in_review', 'medium', meera, 4],
    [app, 'Test order tracking on Android 12', 'task', 'in_progress', 'high', sam, 1],
    [app, 'Notification permission prompt copy', 'task', 'todo', 'low', meera, 9, push.id],
    [app, 'Design notification settings', 'task', 'in_progress', 'medium', dana, 6, push.id],
    [app, 'Crash when cart is empty', 'bug', 'done', 'high', dana, -2],
    [app, 'App store screenshots', 'task', 'backlog', 'low', meera, 30],
    [app, 'Set up crash reporting', 'task', 'done', 'medium', arjun, -6],
    [app, 'Wishlist API endpoints', 'story', 'todo', 'medium', meera, 14],
    [store, 'Kiosk hardware shortlist', 'task', 'in_progress', 'high', arjun, 5],
    [loyalty, 'Points calculation rules', 'task', 'in_review', 'high', meera, 3],
  ]
  const made = []
  for (const [p, title, type, status, priority, who, due, feature_id] of issues) {
    made.push({ who, issue: await call(T, 'POST', '/api/issues', { project_id: p.id, title, type, status, priority, assignee_id: who.id, due_date: day(due), feature_id }) })
  }

  // Budgets: hourly rates, a project budget, and a month of logged time turned into cost.
  await call(T, 'PUT', '/api/admin/modules', { modules: { budgets: true, time: true } })
  for (const [who, rate] of [[arjun, 2400], [dana, 1800], [meera, 1600], [sam, 1400]]) {
    await call(T, 'PATCH', `/api/users/${who.id}`, { hourly_rate: rate })
  }
  await call(T, 'PATCH', `/api/projects/${app.id}`, { budget: 1500000, currency: 'INR' })
  let n = 0
  for (let back = 28; back >= 0; back--) {
    const date = new Date(Date.now() - back * 864e5)
    if (date.getDay() === 0 || date.getDay() === 6) continue
    for (const { who, issue } of made.filter((m) => m.issue.project?.id === app.id || m.issue.project_id === app.id)) {
      if ((n++ % 3) !== 0) continue
      await call(who.token, 'POST', `/api/issues/${issue.id}/time`, { day: date.toISOString().slice(0, 10), hours: 3 + (n % 4), note: '' })
    }
  }

  // Team chat with a little history.
  const group = await call(T, 'POST', '/api/chat/groups', { name: 'Mobile App team', member_ids: [arjun.id, dana.id, sam.id, meera.id] })
  const say = (who, body) => call(who.token, 'POST', `/api/chat/conversations/${group.id}/messages`, { body })
  await say(arjun, 'Morning all! Beta release is 12 days out. How are we looking?')
  await say(dana, 'UPI checkout is merged. Fixing the slow-network payment bug today.')
  const qa = await say(sam, 'Order tracking passed on Android 12 and 13. Starting iOS this afternoon.')
  await say(meera, 'Order status screen is in review. Screenshots are in the docs tab.')
  await call(arjun.token, 'POST', `/api/chat/messages/${qa.id}/reactions`, { emoji: '🎉' })
  await call(dana.token, 'POST', `/api/chat/messages/${qa.id}/reactions`, { emoji: '👍' })
  // A couple of things waiting on Priya, so the dashboard has something to say.
  for (const [p, title, due] of [[app, 'Approve beta release notes', 1], [store, 'Review store layout concepts', 2], [loyalty, 'Sign partner agreement', 4]]) {
    await call(T, 'POST', '/api/issues', { project_id: p.id, title, type: 'task', status: 'todo', priority: 'high', assignee_id: owner.user.id, due_date: day(due) })
  }

  // From here on, stages move only with sign-off.
  for (const p of [app, store, loyalty]) await call(T, 'PATCH', `/api/projects/${p.id}`, { signoff_mode: 'simple' })
  await call(T, 'PATCH', `/api/milestones/${beta.id}`, { stage: 'development' }).catch(() => {})
  // Dana asks for the design of push notifications to be signed off.
  await call(dana.token, 'POST', `/api/projects/${app.id}/signoffs`, { target_type: 'feature', target_id: push.id, note: 'Designs reviewed with the team; Figma link in the docs.' })

  await call(T, 'POST', '/api/onboarding/dismiss')
  await api.dispose()
  return { token: T, app }
}

/* ───────────── Recording helpers ───────────── */

const CURSOR = `
(() => {
  const add = () => {
    if (document.getElementById('demo-cursor')) return
    const c = document.createElement('div')
    c.id = 'demo-cursor'
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 11-7 1-3 7z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>'
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(-100px,-100px)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.35))' })
    document.documentElement.appendChild(c)
    addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)' }, true)
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div')
      Object.assign(r.style, { position: 'fixed', left: e.clientX - 18 + 'px', top: e.clientY - 18 + 'px', width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(99,102,241,.35)', zIndex: 2147483646, pointerEvents: 'none', transition: 'transform .45s ease-out, opacity .45s ease-out' })
      document.documentElement.appendChild(r)
      requestAnimationFrame(() => { r.style.transform = 'scale(1.8)'; r.style.opacity = '0' })
      setTimeout(() => r.remove(), 500)
    }, true)
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', add); else add()
})()`

let mouse = { x: 720, y: 450 }
async function moveTo(page, target, { click = false, steps = 28 } = {}) {
  await target.scrollIntoViewIfNeeded()
  await sleep(150)
  const box = await target.boundingBox()
  if (!box) throw new Error('Nothing to point at')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y, { steps })
  mouse = { x, y }
  if (click) {
    await sleep(250)
    await page.mouse.down()
    await page.mouse.up()
  }
}
async function park(page) {
  await page.mouse.move(mouse.x, mouse.y) // keeps the drawn cursor where the real one is after a reload
}

async function caption(page, title, top = false) {
  await page.evaluate(([text, top]) => {
    document.getElementById('demo-caption')?.remove()
    const el = document.createElement('div')
    el.id = 'demo-caption'
    el.textContent = text
    Object.assign(el.style, {
      position: 'fixed', left: '50%', [top ? 'top' : 'bottom']: top ? '136px' : '28px', transform: 'translateX(-50%) translateY(20px)', opacity: '0',
      background: 'rgba(17,24,39,.88)', color: '#fff', font: '600 17px Inter, system-ui, sans-serif', letterSpacing: '.01em',
      padding: '11px 22px', borderRadius: '999px', zIndex: 2147483645, pointerEvents: 'none',
      boxShadow: '0 10px 30px rgba(0,0,0,.25)', transition: 'opacity .5s ease, transform .5s ease',
    })
    document.documentElement.appendChild(el)
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateX(-50%) translateY(0)' }))
  }, [title, top])
}

function card({ kicker, title, subtitle, cta }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;font-family:Inter,system-ui,-apple-system,sans-serif;overflow:hidden}
    body{display:flex;align-items:center;justify-content:center;color:#fff;
      background:radial-gradient(1200px 700px at 20% 10%,#4f46e5 0%,transparent 60%),radial-gradient(900px 600px at 90% 90%,#0ea5e9 0%,transparent 55%),#0b1020}
    .wrap{text-align:center;animation:in 1.1s cubic-bezier(.2,.8,.2,1) both}
    .logo{display:inline-flex;align-items:center;gap:16px;font-size:44px;font-weight:800;letter-spacing:-.02em;margin-bottom:34px}
    .mark{width:64px;height:64px;border-radius:18px;background:#6366f1;display:grid;place-items:center;box-shadow:0 12px 40px rgba(99,102,241,.6)}
    .kicker{font-size:18px;letter-spacing:.22em;text-transform:uppercase;color:#a5b4fc;margin-bottom:14px;animation:in 1.1s .25s both}
    h1{font-size:64px;line-height:1.08;margin:0 0 22px;font-weight:800;letter-spacing:-.03em;animation:in 1.1s .4s both}
    p{font-size:26px;color:#cbd5e1;margin:0;animation:in 1.1s .6s both}
    .cta{display:inline-block;margin-top:38px;padding:16px 34px;border-radius:999px;background:#fff;color:#312e81;font-weight:700;font-size:22px;animation:in 1.1s .85s both}
    @keyframes in{from{opacity:0;transform:translateY(26px)}to{opacity:1;transform:none}}
  </style></head><body><div class="wrap">
    <div class="logo"><span class="mark"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>Trackly</div>
    ${kicker ? `<div class="kicker">${kicker}</div>` : ''}
    <h1>${title}</h1>
    ${subtitle ? `<p>${subtitle}</p>` : ''}
    ${cta ? `<div class="cta">${cta}</div>` : ''}
  </div></body></html>`
}

/* ───────────── The walkthrough ───────────── */

async function main() {
  fs.rmSync(FRAMES, { recursive: true, force: true })
  fs.mkdirSync(FRAMES, { recursive: true })
  const server = await startServer()
  let browser
  try {
    const { token, app } = await seed()
    browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3, colorScheme: 'light', baseURL: BASE,
      userAgent: UA })
    await context.addInitScript(CURSOR)
    const page = await context.newPage()

    // Frames: the DevTools screencast sends one whenever the picture changes.
    const frames = []
    const cdp = await context.newCDPSession(page)
    cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
      const file = `f${String(frames.length).padStart(5, '0')}.jpg`
      fs.writeFileSync(path.join(FRAMES, file), Buffer.from(data, 'base64'))
      frames.push({ file, t: metadata.timestamp })
      await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    })

    const timeline = []
    let sceneStart = 0
    const scene = async (id, run) => {
      const seconds = voice[id]
      sceneStart = Date.now()
      timeline.push({ id, t: sceneStart / 1000 })
      console.log(`scene ${id} (${seconds.toFixed(1)}s)`)
      await run()
      const left = sceneStart + (seconds + 0.9) * 1000 - Date.now()
      if (left > 0) await sleep(left)
      else console.log(`  ran ${(-left / 1000).toFixed(1)}s over its voice line`)
    }

    await page.setContent(card({ title: '', subtitle: '' }).replace('<h1></h1>', '<h1>&nbsp;</h1>'))
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080 })
    await sleep(600)

    await scene('intro', async () => {
      await page.setContent(card({ kicker: 'Project management', title: 'Every stage signed off.<br>Every team in step.', subtitle: 'Plan features, run the work, and approve each step before the next one starts.' }))
      await sleep(1200)
    })

    // Sign in as Priya (the owner) for the rest of the tour.
    await page.goto('/welcome')
    await page.evaluate((t) => localStorage.setItem('pm_token', t), token)

    await scene('dashboard', async () => {
      await page.goto('/')
      await page.getByRole('heading', { name: /Good (morning|afternoon|evening), Priya/ }).waitFor()
      await park(page)
      await caption(page, 'Your day at a glance')
      await sleep(1500)
      await page.mouse.wheel(0, 380)
      await sleep(1800)
      await page.mouse.wheel(0, -380)
    })

    await scene('features', async () => {
      await page.goto(`/projects/${app.id}?tab=features`)
      await page.getByText('Checkout with UPI').first().waitFor()
      await park(page)
      await caption(page, 'A lifecycle for every feature')
      await sleep(800)
      for (const label of ['Proposed', 'Design', 'Testing', 'Released']) {
        await moveTo(page, page.locator('.pipe', { hasText: label }).first(), { steps: 22 })
        await sleep(650)
      }
      // Show only what is in development: the checkout feature.
      await moveTo(page, page.locator('.pipe', { hasText: 'Development' }).first(), { click: true, steps: 22 })
      await sleep(900)
      await moveTo(page, page.locator('.feature-block', { hasText: 'Checkout with UPI' }).first(), { steps: 30 })
    })

    await scene('signoff', async () => {
      await caption(page, 'Sign off in one click')
      const block = page.locator('.feature-block', { hasText: 'Checkout with UPI' }).first()
      const button = block.getByRole('button', { name: /^Sign off/ }).first()
      await moveTo(page, button, { click: true })
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      await sleep(900)
      const note = dialog.locator('textarea').first()
      if (await note.count()) {
        await moveTo(page, note, { click: true, steps: 18 })
        await page.keyboard.type('Merged and ready for QA.', { delay: 22 })
      }
      await moveTo(page, dialog.getByRole('button', { name: 'Sign off' }), { click: true })
      await page.getByText('No features at this stage').waitFor({ timeout: 5000 }).catch(() => {})
      await sleep(300)
      // It moved on: both beta features are now in testing.
      await moveTo(page, page.locator('.pipe', { hasText: 'Testing' }).first(), { click: true, steps: 20 })
      await page.locator('.feature-block', { hasText: 'Checkout with UPI' }).first().waitFor()
      await sleep(500)
    })

    await scene('approvals', async () => {
      await page.goto(`/projects/${app.id}?tab=approvals`)
      await page.getByRole('heading', { name: 'Waiting for you' }).waitFor()
      await park(page)
      await caption(page, 'Requests go to the owner and managers')
      const waiting = page.locator('.card', { has: page.getByRole('heading', { name: 'Waiting for you' }) })
      await moveTo(page, waiting.getByText('Push notifications').first(), { steps: 30 })
      await sleep(1200)
      await moveTo(page, waiting.getByRole('button', { name: 'Sign off' }).first(), { click: true })
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      await sleep(1000)
      await moveTo(page, dialog.getByRole('button', { name: 'Approve' }), { click: true })
      await page.getByRole('heading', { name: 'Decided' }).waitFor()
    })

    await scene('milestones', async () => {
      await page.goto(`/projects/${app.id}?tab=milestones`)
      await page.getByText('Beta release').first().waitFor()
      await park(page)
      await caption(page, 'Features and milestones move together')
      await moveTo(page, page.getByText('Beta release').first(), { steps: 30 })
      await sleep(1500)
      await moveTo(page, page.getByText('Public launch').first(), { steps: 30 })
    })

    await scene('board', async () => {
      await page.goto(`/projects/${app.id}?tab=board`)
      await page.getByText('Integrate UPI payment SDK').first().waitFor()
      await park(page)
      await caption(page, 'The team board, live')
      await moveTo(page, page.getByText('Payment fails on slow networks').first(), { steps: 30 })
      await sleep(900)
      await moveTo(page, page.getByText('Order status timeline screen').first(), { steps: 30 })
      await sleep(900)
      await moveTo(page, page.getByText('Crash when cart is empty').first(), { steps: 30 })
    })

    await scene('budget', async () => {
      await page.goto(`/projects/${app.id}?tab=overview`)
      const heading = page.getByRole('heading', { name: 'Budget', exact: true })
      await heading.waitFor()
      await park(page)
      await caption(page, 'Budgets and costs from logged time')
      await heading.evaluate((el) => el.closest('.card').scrollIntoView({ behavior: 'smooth', block: 'center' }))
      await sleep(1300)
      const card = page.locator('.card', { has: heading })
      await moveTo(page, card.getByText(/% used/).first(), { steps: 30 })
      await sleep(1600)
      const person = card.getByText('Dana Lee').first()
      if (await person.count()) await moveTo(page, person, { steps: 30 })
    })

    await scene('chat', async () => {
      await page.goto('/chat')
      const group = page.locator('.chat-list').getByText('Mobile App team').first()
      await group.waitFor()
      await park(page)
      await caption(page, 'Team chat, next to the work', true)
      await moveTo(page, group, { click: true })
      const box = page.getByRole('textbox', { name: 'Message' })
      await box.waitFor()
      await sleep(900)
      await moveTo(page, box, { click: true, steps: 24 })
      await page.keyboard.type('Great work, team! Beta sign-off is on track 🚀', { delay: 34 })
      await sleep(300)
      await moveTo(page, page.getByRole('button', { name: 'Send message' }), { click: true, steps: 16 })
      await sleep(600)
    })

    await scene('roadmap', async () => {
      await page.goto('/roadmap')
      await page.getByText('Mobile App 2.0').first().waitFor()
      await park(page)
      await caption(page, 'One roadmap for every project')
      await sleep(800)
      await moveTo(page, page.getByText('Store Redesign').first(), { steps: 30 })
    })

    await scene('security', async () => {
      await page.goto('/profile')
      await page.getByTestId('workspace-id').waitFor()
      await park(page)
      await caption(page, 'Your own private, secure workspace')
      await moveTo(page, page.getByTestId('workspace-id'), { steps: 30 })
      await sleep(1600)
      const twoFactor = page.getByText(/Two-factor sign-in/).first()
      if (await twoFactor.count()) {
        await twoFactor.scrollIntoViewIfNeeded()
        await sleep(400)
        await moveTo(page, twoFactor, { steps: 30 })
      }
    })

    await scene('modules', async () => {
      await page.goto('/settings')
      await page.getByRole('heading', { name: 'Workspace settings' }).waitFor()
      await park(page)
      await caption(page, 'Only the modules your team needs')
      const modules = page.locator('.module-list')
      await modules.scrollIntoViewIfNeeded()
      await sleep(500)
      await moveTo(page, page.getByRole('checkbox', { name: /^Test cases: off/ }).locator('..'), { click: true })
      await sleep(1100)
      await moveTo(page, page.getByRole('checkbox', { name: /^Workload: off/ }).locator('..'), { click: true })
    })

    await scene('outro', async () => {
      await page.setContent(card({ title: 'Plan it. Build it.<br>Sign it off.', subtitle: 'Your own workspace in under a minute. No payment details needed.', cta: 'Start your free 14-day trial' }))
      await sleep(1500)
    })
    await sleep(1200)
    await cdp.send('Page.stopScreencast')
    await sleep(300)

    const end = Date.now() / 1000
    fs.writeFileSync(path.join(BUILD, 'frames.json'), JSON.stringify({ frames, end }, null, 1))
    fs.writeFileSync(path.join(BUILD, 'timeline.json'), JSON.stringify(timeline, null, 1))
    console.log(`${frames.length} frames, ${(end - frames[0].t).toFixed(1)}s`)
  } finally {
    await browser?.close()
    server.kill()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
