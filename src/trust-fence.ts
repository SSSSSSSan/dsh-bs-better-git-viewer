/**
 * Browser-trust fence for the /bsgit API, mirroring the shell's
 * api-request-trust model: Host must be loopback or one of the web runtime's
 * trustedHosts; a cross-site Fetch-Metadata marker is refused; an Origin, when
 * present, must be exactly this authority.
 */
import type { IncomingHttpHeaders } from 'node:http'

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

export function isTrustedApiRequest(
  headers: IncomingHttpHeaders,
  trustedHosts: readonly string[],
): boolean {
  const host = header(headers, 'host')
  if (host === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostname) && !trustedHosts.some(entry => {
    try {
      return new URL(`http://${entry}`).hostname === hostname
    } catch {
      return false
    }
  })) {
    return false
  }
  if (header(headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostname
  } catch {
    return false
  }
}
