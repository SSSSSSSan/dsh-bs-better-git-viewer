/**
 * dsh-bs-better-git — CLIENT half.
 *
 * Registers two tabs into ctx.betterSidebar:
 *  - `bs-git-viewer` — the multi-repo Git browser (talks to /bsgit API).
 *  - `san-terminal` — an interactive terminal (xterm.js over the
 *    better-sidebar /sidebar/ws/terminal endpoint, which accepts any tab id;
 *    blinking cursor + word wrap enabled).
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the better-sidebar Context augmentation (ctx.betterSidebar)
// and the tab descriptor types; erased at build time.
import type { SidebarState, TabDescriptor } from 'dsh-better-sidebar/client/service'
import type {} from 'dsh-better-sidebar/client/service'
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { GitView } from './GitView.tsx'
import { ExcludesSettings } from './ExcludesSettings.tsx'
import { TerminalView } from './TerminalView.tsx'
import { IconTerminalOutline16 } from './icons.tsx'

/** Services required before mounting. */
export const inject = ['betterSidebar']

/** How many san-terminal tabs may be open at once per session. */
const SAN_TERMINAL_LIMIT = 3

/** Minimal tab shape read out of the sidebar split trees. */
interface SanTab { id: string; type: string }

/** Collect every tab of one split-tree node (leaf | split) recursively. */
function collectTabs(node: unknown, out: SanTab[]): void {
  if (node === null || typeof node !== 'object') return
  const n = node as { kind?: unknown; tabs?: unknown; children?: unknown }
  if (n.kind === 'leaf' && Array.isArray(n.tabs)) {
    for (const raw of n.tabs) {
      const tab = raw as { id?: unknown; type?: unknown }
      if (typeof tab.id === 'string' && typeof tab.type === 'string') out.push({ id: tab.id, type: tab.type })
    }
    return
  }
  if (Array.isArray(n.children)) for (const child of n.children) collectTabs(child, out)
}

/** Every tab across both sidebar panels (right tree + bottom tree). */
function allTabs(state: SidebarState): SanTab[] {
  const out: SanTab[] = []
  collectTabs(state.splits, out)
  collectTabs(state.bottomSplits, out)
  return out
}

/** Count UI-owned san-terminal tabs in a sidebar state. */
function sanTerminalCount(state: SidebarState): number {
  return allTabs(state).filter(tab => tab.type === 'san-terminal').length
}

/** Next `san-terminal:<n>` id: max existing suffix + 1 (own counter, does not
 *  touch the built-in terminal's `nextTerminal`). */
function nextSanTerminalId(state: SidebarState): number {
  let max = 0
  for (const tab of allTabs(state)) {
    if (tab.type !== 'san-terminal') continue
    const m = /^san-terminal:(\d+)$/.exec(tab.id)
    if (m !== null) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/** The git tab: one instance, visible in the + menu. */
const gitTabDescriptor: TabDescriptor = {
  id: 'bs-git-viewer',
  title: () => 'Git',
  icon: <IconBranchOutline16 />,
  order: 20,
  single: true,
  component: (props) => createElement(GitView, props),
  // The gear in the sidebar settings opens the exclude-list editor: one
  // directory name per line, saved to the session's .dsh-bs-git-excludes.
  settings: {
    render: (props) => createElement(ExcludesSettings, props),
  },
}

/** The terminal tab: mints `san-terminal:<n>` ids, quota-gated. */
const terminalTabDescriptor: TabDescriptor = {
  id: 'san-terminal',
  title: () => '终端',
  icon: <IconTerminalOutline16 />,
  order: 45,
  available: (_ctx, _scope, state) => sanTerminalCount(state) < SAN_TERMINAL_LIMIT,
  createTab: (state) => {
    if (sanTerminalCount(state) >= SAN_TERMINAL_LIMIT) return null
    const n = nextSanTerminalId(state)
    return {
      tab: { id: `san-terminal:${n}`, type: 'san-terminal', title: `终端 ${n}` },
      patch: {},
    }
  },
  component: (props) => createElement(TerminalView, props),
}

/** Client plugin body. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.betterSidebar.registerTab(gitTabDescriptor), 'dsh-bs-better-git: register git tab')
  ctx.effect(() => ctx.betterSidebar.registerTab(terminalTabDescriptor), 'dsh-bs-better-git: register terminal tab')
}
