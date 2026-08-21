/**
 * Minimal JSON wire helpers for the /bsgit API (Node http server side).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Read and parse a JSON request body (rejects invalid JSON / oversized). */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1024 * 1024) throw new ApiError('bad-request', 'request body too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new ApiError('bad-request', 'invalid JSON body')
  }
}

/** A business error mapped to { ok: false, error: { code, message } }. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

export function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

export function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    writeJson(res, 200, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  writeJson(res, 200, {
    ok: false,
    error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
  })
}
