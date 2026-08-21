/**
 * Interactive terminal tab (san-terminal): xterm.js over a WebSocket to the
 * host pty. Copied from dsh-better-sidebar's TerminalView and trimmed to a
 * UI-owned terminal (the host side is the better-sidebar /sidebar/ws/terminal
 * endpoint, which accepts any tab id). Two tweaks on top of the original:
 *  - cursorBlink: true (blinking cursor)
 *  - wordWrap: true (long lines wrap instead of overflowing the element)
 *
 * Wire protocol: the host replays the transcript on connect, then streams
 * live output; input frames are raw text, resize frames are JSON with
 * type:"resize". A server-side refusal (1011 + reason, e.g. pty spawn
 * failure) stops the loop and shows the reason with a manual retry.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Terminal } from 'xterm'
import type { ITheme } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TabComponentProps } from 'dsh-better-sidebar/client/service'
// Raw (non-module) stylesheet: xterm's own CSS must keep its original class
// names, so it is inlined verbatim by the build (no CSS-module hashing).
import './terminal.css'

/** Consecutive unreasoned failures before showing the error banner. */
const FAILURE_LIMIT = 3

/** Curated ANSI palettes (one-dark / one-light families). */
const ANSI_DARK: Record<string, string> = {
  black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
  blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
  brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
  brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
  brightCyan: '#56b6c2', brightWhite: '#ffffff',
}

const ANSI_LIGHT: Record<string, string> = {
  black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
  blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#a0a1a7',
  brightBlack: '#4f525e', brightRed: '#e45649', brightGreen: '#50a14f',
  brightYellow: '#c18401', brightBlue: '#0184bc', brightMagenta: '#a626a4',
  brightCyan: '#0997b3', brightWhite: '#fafafa',
}

function tokenValue(name: string): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value === '' ? undefined : value
}

function isDarkScheme(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** The xterm theme: surface colors from the shell tokens, curated ANSI set. */
function xtermTheme(): ITheme {
  const dark = isDarkScheme()
  const background = tokenValue('--dsw-alias-bg-base') || (dark ? '#111114' : '#ffffff')
  const foreground = tokenValue('--dsw-alias-label-primary') || (dark ? '#e6e6e6' : '#1a1a1a')
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.12)',
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  }
}

export function TerminalView(props: TabComponentProps): ReactNode {
  const { scope, tab } = props
  const tabId = tab.id
  const hostRef = useRef<HTMLDivElement>(null)
  const [connected, setConnected] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)
  const connectRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const term = new Terminal({
      cursorBlink: true,   // blinking cursor
      fontSize: 13,
      allowTransparency: true,
      convertEol: false,
      scrollback: 4000,
      theme: xtermTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    let socket: WebSocket | null = null
    let closed = false
    let retry: number | undefined
    let failures = 0

    const wsUrl = (): string => {
      const url = new URL('/sidebar/ws/terminal', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const params = new URLSearchParams({ sessionId: scope.sessionId, tab: tabId })
      if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
      url.search = params.toString()
      return url.toString()
    }

    const sendResize = (): void => {
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    const connect = (): void => {
      if (closed) return
      socket = new WebSocket(wsUrl())
      socket.onopen = () => {
        failures = 0
        setConnected(true)
        setFatal(null)
        sendResize()
      }
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') term.write(event.data)
      }
      socket.onclose = (event) => {
        setConnected(false)
        if (event.code === 1011 && event.reason !== '') {
          setFatal(event.reason)
          return
        }
        failures += 1
        if (failures >= FAILURE_LIMIT) {
          const detail = event.reason !== '' ? ` (${event.code}: ${event.reason})` : ` (${event.code})`
          console.error('[san-terminal] connection failed:', event.code, event.reason)
          setFatal(`连接失败${detail}`)
          return
        }
        if (!closed) retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => {
        socket?.close()
      }
    }
    connectRef.current = connect

    const inputSub = term.onData((data) => {
      if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(data)
    })

    // xterm must not open in a zero-size container (renderer crashes). Defer
    // open+fit until the host has a real size; a ResizeObserver keeps the
    // grid fitted afterwards.
    let opened = false
    let contextMenuDisposer: (() => void) | undefined
    const maybeOpen = (): void => {
      if (opened || host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        term.open(host)
        fit.fit()
        sendResize()
        opened = true
        // Windows-terminal style: right-click COPIES the selection. The
        // listener sits on the terminal CONTAINER (contextmenu bubbles up
        // from the canvas — the helper textarea is off-screen and never
        // receives events). Ctrl+C stays free for SIGINT, so copy lives here.
        const onContextMenu = (event: MouseEvent): void => {
          const selection = term.getSelection()
          if (selection === '') return // no selection: keep the default path
          event.preventDefault()
          event.stopPropagation()
          void navigator.clipboard.writeText(selection).catch(() => {})
        }
        host.addEventListener('contextmenu', onContextMenu)
        contextMenuDisposer = () => host.removeEventListener('contextmenu', onContextMenu)
      } catch (error) {
        console.error('[san-terminal] xterm open failed:', error)
      }
    }
    const observer = new ResizeObserver(() => {
      maybeOpen()
      if (opened) {
        try {
          fit.fit()
          sendResize()
        } catch {
          // mid-dispose; ignore
        }
      }
    })
    observer.observe(host)
    maybeOpen()

    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      observer.disconnect()
      contextMenuDisposer?.()
      inputSub.dispose()
      socket?.close()
      term.dispose()
      connectRef.current = null
    }
  }, [scope.sessionId, scope.cwd, tabId])

  return (
    <div className="san-t-wrap">
      {fatal !== null && (
        <div className="san-t-banner">
          终端错误：{fatal}
          <button
            type="button"
            className="san-t-retry"
            onClick={() => { setFatal(null); connectRef.current?.() }}
          >
            重试
          </button>
        </div>
      )}
      {fatal === null && !connected && <div className="san-t-banner">连接中…</div>}
      <div ref={hostRef} className="san-t-host" />
    </div>
  )
}
