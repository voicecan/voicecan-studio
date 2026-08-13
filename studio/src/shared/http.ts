import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { DeviceEvent } from '@voicecan/contracts';
import { parseVoicecanWebhook } from '../platform/webhook.js';

export type RouteContext = { request: IncomingMessage; response: ServerResponse; url: URL };
export type RouteHandler = (context: RouteContext) => Promise<void> | void;

export function createHttpServer(handler: RouteHandler): Server {
  return createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'");
    try {
      validateRequestBoundary(request);
      await handler({ request, response, url: new URL(request.url ?? '/', 'http://localhost') });
    } catch (error) {
      const message = sanitizeError(error);
      sendJson(response, routeErrorStatus(error), { error: error instanceof Error ? error.message.split(':')[0] : 'INTERNAL_ERROR', message });
    }
  });
}

export async function readBody(request: IncomingMessage, limit = 512 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readJson(request: IncomingMessage, limit?: number): Promise<unknown> {
  const body = await readBody(request, limit);
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('CONTENT_TYPE_INVALID'), { status: 415 });
  try { return JSON.parse(body.toString('utf8')) as unknown; }
  catch { throw Object.assign(new Error('INVALID_JSON'), { status: 400 }); }
}

export async function readVerifiedEvent(request: IncomingMessage, secrets: string | readonly string[]): Promise<DeviceEvent> {
  const rawBody = await readBody(request, 256 * 1024);
  const configured = (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean);
  return parseVoicecanWebhook({
    rawBody,
    headers: request.headers,
    secrets: configured,
  });
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

export function sendText(response: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  response.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/(authorization|bearer|token|secret|password|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 400);
}

export function routeErrorStatus(error: unknown): number {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 500;
}

export function requireOperator(request: IncomingMessage, configuredToken = process.env.DEMO_OPERATOR_TOKEN): void {
  if (configuredToken) {
    const supplied = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const expected = Buffer.from(configuredToken); const actual = Buffer.from(supplied);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw Object.assign(new Error('OPERATOR_UNAUTHORIZED'), { status: 401 });
    return;
  }
  const localAddress = request.socket.localAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(localAddress)) throw Object.assign(new Error('OPERATOR_TOKEN_REQUIRED'), { status: 403 });
}

function validateRequestBoundary(request: IncomingMessage): void {
  const rawHost = String(request.headers.host ?? '');
  const hostname = rawHost.startsWith('[') ? rawHost.slice(1, rawHost.indexOf(']')) : rawHost.split(':')[0] ?? '';
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1', ...String(process.env.DEMO_ALLOWED_HOSTS ?? '').split(',').map((value) => value.trim()).filter(Boolean)]);
  if (!allowedHosts.has(hostname)) throw Object.assign(new Error('HOST_NOT_ALLOWED'), { status: 403 });
  const origin = request.headers.origin;
  if (!origin) return;
  let originUrl: URL;
  try { originUrl = new URL(origin); } catch { throw Object.assign(new Error('ORIGIN_NOT_ALLOWED'), { status: 403 }); }
  const allowedOrigins = new Set(String(process.env.DEMO_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  if (originUrl.host !== rawHost && !allowedOrigins.has(originUrl.origin)) throw Object.assign(new Error('ORIGIN_NOT_ALLOWED'), { status: 403 });
}

