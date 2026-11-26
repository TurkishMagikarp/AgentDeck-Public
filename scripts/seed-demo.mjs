// Seeds a running mock instance with a believable demo project: node scripts/seed-demo.mjs [baseUrl]
// AGENTDECK_LANG=de|en picks the language of the project and its issues (default en).
const base = process.argv[2] ?? 'http://localhost:8811'
const LANG = process.env.AGENTDECK_LANG === 'de' ? 'de' : 'en'

const TEXTS = {
  de: {
    description: 'Kleiner Onlineshop mit Checkout, Adminbereich und nächtlichem Lagerabgleich.',
    roles: {
      Lead: 'Tech Lead, prüft und plant',
      'Backend-Dev': 'Erfahrener Backend-Entwickler',
      'Frontend-Dev': 'UI-Entwickler',
      QA: 'Testet alles, bevor es landet',
    },
    milestone: 'Meilenstein',
    issues: [
      'Projektgerüst anlegen',
      'API für den Produktkatalog',
      'Warenkorb im Session-Speicher',
      'Checkout mit Stripe im Testmodus',
      'Bestellbestätigung per Mail',
      'Admin: Produkteditor',
      'Routine für den nächtlichen Lagerabgleich',
      'Barrierefreiheit im Checkout prüfen',
      'Fix: Warenkorbsumme rundet mit Gutscheinen falsch',
      'Login-Endpunkt mit Rate-Limit',
    ],
    doneWhen: 'Die Tests laufen grün und die Änderung ist geprüft.',
    seeded: 'Projekt angelegt:',
  },
  en: {
    description: 'Small online shop with checkout, admin area and nightly stock sync.',
    roles: {
      Lead: 'Tech lead, reviews and plans',
      'Backend-Dev': 'Senior backend engineer',
      'Frontend-Dev': 'UI engineer',
      QA: 'Tests everything before it lands',
    },
    milestone: 'Milestone',
    issues: [
      'Set up project skeleton',
      'Product catalog API',
      'Shopping cart with session storage',
      'Checkout with Stripe test mode',
      'Order confirmation emails',
      'Admin: product editor',
      'Nightly stock sync routine',
      'Accessibility pass on checkout',
      'Fix: cart total rounds wrong with coupons',
      'Rate limit the login endpoint',
    ],
    doneWhen: 'Tests pass and the change is reviewed.',
    seeded: 'seeded project',
  },
}
const text = TEXTS[LANG]

const call = async (method, path, body) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-agentdeck-lang': LANG },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

const project = await call('POST', '/api/projects', {
  key: 'SHOP',
  name: 'Webshop',
  description: text.description,
  paused: true,
  settings: { language: LANG },
})
const pid = project.id
const agents = [
  ['Lead', 'anthropic'],
  ['Backend-Dev', 'anthropic'],
  ['Frontend-Dev', 'openai'],
  ['QA', 'anthropic'],
]
for (const [name, provider] of agents) {
  const role = text.roles[name]
  await call('POST', `/api/projects/${pid}/agents`, { name, role, provider, model: '', instructions: role, max_instances: 1 })
}

// Same order as the titles in TEXTS; the last column is the milestone, 0 for none.
const issues = [
  ['done', 1, 'Backend-Dev', 1],
  ['done', 2, 'Backend-Dev', 1],
  ['review', 2, 'Frontend-Dev', 1],
  ['in_progress', 3, 'Backend-Dev', 2],
  ['todo', 1, 'Backend-Dev', 2],
  ['todo', 2, 'Frontend-Dev', 2],
  ['backlog', 1, '', 3],
  ['backlog', 2, 'QA', 3],
  ['todo', 3, 'Backend-Dev', 0],
  ['backlog', 2, '', 0],
]
for (const [index, [status, priority, assignee, milestone]] of issues.entries()) {
  const title = text.issues[index]
  await call('POST', `/api/projects/${pid}/issues`, {
    title,
    status,
    priority,
    assignee: assignee || undefined,
    group: milestone ? `${text.milestone} ${milestone}` : undefined,
    description: `## Task\n${title}\n\n## Files\nsrc/\n\n## Done when\n${text.doneWhen}`,
  })
}
console.log(text.seeded, pid)
