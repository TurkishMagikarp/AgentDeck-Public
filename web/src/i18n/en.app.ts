// App shell, login and shared widgets (App.tsx, Login.tsx, ui.tsx).
export const en_app: Record<string, string> = {
  // views and settings tabs
  Board: 'Board',
  Statistiken: 'Statistics',
  'Live-Feed': 'Live feed',
  Journal: 'Journal',
  Abhängigkeiten: 'Dependencies',
  Git: 'Git',
  Agenten: 'Agents',
  Einstellungen: 'Settings',
  Projekt: 'Project',
  'Usage & Routing': 'Usage & routing',
  Routinen: 'Routines',
  Watchdog: 'Watchdog',
  Skills: 'Skills',

  // sidebar, account menu
  'Mission Control': 'Mission Control',
  '{n} brauchen dich': '{n} need you',
  Konto: 'Account',
  'Anbieter und Zugänge': 'Providers and access',
  Benutzer: 'Users',
  Änderungsprotokoll: 'Audit log',
  'Darstellung: {mode}': 'Appearance: {mode}',
  System: 'System',
  Dunkel: 'Dark',
  Hell: 'Light',
  'Abmelden||Konto': 'Sign out',
  Sprache: 'Language',
  'Sprache wechseln (Deutsch, English)': 'Switch language (Deutsch, English)',

  // top bar
  'Projekt wechseln': 'Switch project',
  'Issues suchen': 'Search issues',
  Mehr: 'More',
  'Neues Projekt': 'New project',
  Ansichten: 'Views',
  Suchen: 'Search',
  'Strg K': 'Ctrl K',
  'ADHD-Modus': 'ADHD mode',
  'Agenten antworten mit einer Ergebniszeile und höchstens drei Stichpunkten':
    'Agents answer with one result line and at most three bullet points',
  Caveman: 'Caveman',
  'Agenten schreiben knapp wie ein Höhlenmensch und sparen Ausgabe-Tokens. Code, Befehle und Status bleiben exakt.':
    'Agents write tersely like a caveman and save output tokens. Code, commands and status stay exact.',
  Fortsetzen: 'Resume',
  Pausieren: 'Pause',

  // command palette
  'Mission Control öffnen': 'Open Mission Control',
  'G dann M': 'G then M',
  'Neues Projekt anlegen': 'Create new project',
  'Darstellung wechseln (System, Dunkel, Hell)': 'Switch appearance (System, Dark, Light)',
  'Projekt öffnen: {name}': 'Open project: {name}',
  'Projekt fortsetzen': 'Resume project',
  'Projekt pausieren': 'Pause project',
  'Ansicht: {name}': 'View: {name}',
  '{id} im Backlog angelegt': '{id} added to the backlog',

  // welcome
  'Noch kein Projekt': 'No project yet',
  'Beschreibe, was gebaut werden soll, und lass die KI Agenten, Skills und Issues vorschlagen.':
    'Describe what should be built and let the AI suggest agents, skills and issues.',
  'Erstes Projekt anlegen': 'Create your first project',

  // login
  Anmelden: 'Sign in',
  'Dieser Server ist geschützt. Gib das Zugangs-Token ein (AGENTDECK_TOKEN).':
    'This server is protected. Enter the access token (AGENTDECK_TOKEN).',
  'Zugangs-Token': 'Access token',
  'Das Token stimmt nicht.': 'The token is wrong.',

  // words that read the same in English
  Issue: 'Issue',
  Commits: 'Commits',
  Status: 'Status',
  Repository: 'Repository',
  Label: 'Label',
  Webhooks: 'Webhooks',

  // shared widgets
  Schließen: 'Close',
  'gerade eben': 'just now',
  'vor {n} min': '{n} min ago',
  'vor {n} h': '{n} h ago',
}
