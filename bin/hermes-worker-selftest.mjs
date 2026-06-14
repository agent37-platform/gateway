#!/usr/bin/env node
import 'dotenv/config';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

function expandHomePrefix(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function resolveHomeAwarePath(value) {
  return resolve(expandHomePrefix(value));
}

function resolveHermesHome() {
  return resolveHomeAwarePath(process.env.HERMES_HOME?.trim() || '~/.hermes');
}

function resolveAgentDirFromHermesCli() {
  try {
    const hermesBin = execFileSync('which', ['hermes'], { encoding: 'utf8' }).trim();
    const real = realpathSync(hermesBin);
    const candidate = resolve(dirname(real), '..', '..');
    if (existsSync(join(candidate, 'run_agent.py'))) return candidate;
  } catch {
    // Fall through to the remaining defaults.
  }
  return undefined;
}

function resolvePython() {
  if (process.env.HERMES_PYTHON) return expandHomePrefix(process.env.HERMES_PYTHON);

  const candidates = [];
  if (process.env.HERMES_AGENT_DIR) {
    candidates.push(join(expandHomePrefix(process.env.HERMES_AGENT_DIR), 'venv/bin/python'));
  }
  candidates.push(join(resolveHermesHome(), 'hermes-agent/venv/bin/python'));

  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  const cliAgentDir = resolveAgentDirFromHermesCli();
  if (cliAgentDir) {
    const venvPython = join(cliAgentDir, 'venv/bin/python');
    if (existsSync(venvPython)) return venvPython;
  }

  return 'python3';
}

function resolveWorkerScript() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../server/workers/hermes_worker.py'),
    resolve(here, '../dist/server/server/workers/hermes_worker.py'),
    resolve(process.cwd(), 'server/workers/hermes_worker.py'),
    resolve(process.cwd(), 'dist/server/server/workers/hermes_worker.py'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    console.error(`Hermes worker script not found. Tried: ${candidates.join(', ')}`);
    process.exit(1);
  }
  return found;
}

const python = resolvePython();
const script = resolveWorkerScript();
const result = spawnSync(python, [script, '--self-test'], {
  stdio: 'inherit',
  env: { ...process.env, HERMES_QUIET: '1' },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
