#!/usr/bin/env node
/**
 * Install dsh-bs-better-git-viewer into a DSH profile.
 *
 * Uses ONLY the official DSH CLI (`dsh plugin --profile <name> add <dir>`):
 *   - default: fetch the CLI on demand via npx (`@deepseek-ai/dsh`) — works on
 *     any machine, no local DSH checkout or global install required;
 *   - local source build: pass `--dsh-dir <path>` (or set `DSH_REPO_DIR`) to
 *     run `pnpm dsh ...` from the DSH source checkout instead.
 *
 * No machine-specific paths are embedded — the optional dsh-dir is supplied
 * at run time and never stored in the repo.
 *
 * Usage:
 *   node scripts/install.mjs [--profile <name>] [--dsh-dir <path>] [--skip-build]
 *
 * (profile defaults to 'web'; the plugin is built first unless --skip-build)
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-bs-better-git-viewer'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 || args[i + 1] === undefined ? fallback : args[i + 1]
}
const profile = opt('--profile', 'web')
const dshDir = opt('--dsh-dir', process.env.DSH_REPO_DIR ?? null)
const skipBuild = args.includes('--skip-build')

const fail = (message) => {
  console.error(`[install] ${message}`)
  process.exit(1)
}

function run(label, command, cmdArgs, options = {}) {
  process.stdout.write(`\n== ${label}\n> ${command} ${cmdArgs.join(' ')} (cwd: ${options.cwd ?? process.cwd()})\n`)
  const result = spawnSync(command, cmdArgs, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) fail(`spawn failed: ${result.error.message}`)
  if (result.status !== 0) fail(`${label} failed (exit ${String(result.status)})`)
}

function capture(command, cmdArgs, options = {}) {
  const result = spawnSync(command, cmdArgs, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  return { status: result.status ?? 1, stdout: result.stdout ?? '' }
}

/** The official CLI invocation for the chosen mode (npx or source build). */
function dsh(subArgs) {
  if (dshDir !== null) {
    // The DSH source checkout is a pnpm workspace root; pnpm refuses to run
    // there without this flag. CI=1 keeps the CLI non-interactive.
    return {
      command: 'pnpm',
      args: ['dsh', ...subArgs],
      env: { ...process.env, npm_config_ignore_workspace_root_check: 'true', CI: '1' },
      cwd: dshDir,
    }
  }
  return {
    command: 'npx',
    args: ['-y', '--package', '@deepseek-ai/dsh', 'dsh', ...subArgs],
    env: process.env,
    cwd: undefined,
  }
}

if (!skipBuild) run('build plugin', 'pnpm', ['build'], { cwd: PLUGIN_DIR })

const install = dsh(['plugin', '--profile', profile, 'add', PLUGIN_DIR])
run('install via official DSH CLI', install.command, install.args, { cwd: install.cwd, env: install.env })

const verify = dsh(['--profile', profile, '--dump-config'])
const dump = capture(verify.command, verify.args, { cwd: verify.cwd, env: verify.env })
if (dump.status !== 0 || !dump.stdout.includes(`# == ${PACKAGE_NAME}`)) {
  fail(`VERIFY FAILED: "# == ${PACKAGE_NAME}" layer not found in --dump-config (exit ${dump.status})`)
}
console.log(`[install] layer active ✓  (# == ${PACKAGE_NAME} in --dump-config)`)

console.log('\n[install] 完成。重启 dsh（host 半加载）后，在侧边栏 + 菜单选择「Git」/「终端」。')
