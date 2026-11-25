// Seeds a running mock instance with a believable demo project: node scripts/seed-demo.mjs [baseUrl]
const base = process.argv[2] ?? 'http://localhost:8811'
const call = async (method, path, body) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

const project = await call('POST', '/api/projects', {
  key: 'SHOP',
  name: 'Webshop',
  description: 'Small online shop with checkout, admin area and nightly stock sync.',
  paused: true,
})
const pid = project.id
const agents = [
  ['Lead', 'Tech lead, reviews and plans', 'anthropic'],
  ['Backend-Dev', 'Senior backend engineer', 'anthropic'],
  ['Frontend-Dev', 'UI engineer', 'openai'],
  ['QA', 'Tests everything before it lands', 'anthropic'],
]
for (const [name, role, provider] of agents)
  await call('POST', `/api/projects/${pid}/agents`, { name, role, provider, model: '', instructions: role, max_instances: 1 })

const issues = [
  ['Set up project skeleton', 'done', 1, 'Backend-Dev', 'Milestone 1'],
  ['Product catalog API', 'done', 2, 'Backend-Dev', 'Milestone 1'],
  ['Shopping cart with session storage', 'in_review', 2, 'Frontend-Dev', 'Milestone 1'],
  ['Checkout with Stripe test mode', 'in_progress', 3, 'Backend-Dev', 'Milestone 2'],
  ['Order confirmation emails', 'todo', 1, 'Backend-Dev', 'Milestone 2'],
  ['Admin: product editor', 'todo', 2, 'Frontend-Dev', 'Milestone 2'],
  ['Nightly stock sync routine', 'backlog', 1, '', 'Milestone 3'],
  ['Accessibility pass on checkout', 'backlog', 2, 'QA', 'Milestone 3'],
  ['Fix: cart total rounds wrong with coupons', 'todo', 3, 'Backend-Dev', ''],
  ['Rate limit the login endpoint', 'backlog', 2, '', ''],
]
for (const [title, status, priority, assignee, group] of issues)
  await call('POST', `/api/projects/${pid}/issues`, {
    title,
    status,
    priority,
    assignee: assignee || undefined,
    group: group || undefined,
    description: `## Task\n${title}\n\n## Files\nsrc/\n\n## Done when\nTests pass and the change is reviewed.`,
  })
console.log('seeded project', pid)
