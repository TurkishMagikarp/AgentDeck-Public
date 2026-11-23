// Imported first by every test file: points AgentDeck at an empty data folder of its own, so the
// tests never touch real data and start from a fresh database.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTDECK_DATA = mkdtempSync(join(tmpdir(), 'agentdeck-test-'))
process.env.AGENTDECK_SECRET = 'test-secret'
