import type { MeetingSummaryV1, NotificationTarget, ScenarioResultV1, TranscriptionJob, TranscriptV1 } from './shared/index.js';
import { createHttpServer, readJson, readVerifiedEvent, requireOperator, routeErrorStatus, sanitizeError, sendJson, sendText } from './shared/index.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StudioService } from './service.js';
import type { StudioRuntime } from './runtime.js';
import { STUDIO_PAGE } from './studio-page.js';
import { capabilityRegistry } from './capabilities/index.js';

async function streamAudio(request: IncomingMessage, response: ServerResponse, file: { path: string; contentType: string; filename: string }): Promise<void> {
  const size = (await stat(file.path)).size;
  const range = request.headers.range;
  const common = {
    'accept-ranges': 'bytes', 'cache-control': 'private, no-store', 'content-type': file.contentType,
    'content-disposition': `inline; filename="${file.filename}"`,
  };
  if (!range) {
    response.writeHead(200, { ...common, 'content-length': size });
    if (request.method === 'HEAD') response.end(); else createReadStream(file.path).pipe(response);
    return;
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) {
    response.writeHead(416, { ...common, 'content-range': `bytes */${size}` }).end(); return;
  }
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    response.writeHead(416, { ...common, 'content-range': `bytes */${size}` }).end(); return;
  }
  end = Math.min(end, size - 1);
  response.writeHead(206, { ...common, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
  if (request.method === 'HEAD') response.end(); else createReadStream(file.path, { start, end }).pipe(response);
}

export function createStudioServer(input: {
  service?: StudioService;
  webhookSecret?: string | readonly string[];
  runtime?: StudioRuntime;
  deploymentProfile?: 'external' | 'local-full';
  syncRecordings?: () => Promise<Record<string, unknown>>;
  syncStatus?: () => Record<string, unknown>;
  healthDiagnostics?: () => Promise<Record<string, unknown> & { ok: boolean }>;
}) {
  const capabilities = capabilityRegistry.list().map(({ id, version, dependsOn, permissions, apiContributors, uiContributors }) => ({ id, version, depends_on: dependsOn, permissions, api_contributors: apiContributors, ui_contributors: uiContributors }));
  const requiredService = (): StudioService => {
    const service = input.runtime?.service ?? input.service;
    if (!service) throw Object.assign(new Error('STUDIO_NOT_CONFIGURED'), { status: 503 });
    return service;
  };
  return createHttpServer(async ({ request, response, url }) => {
    try {
      if (request.method === 'GET' && url.pathname === '/') return sendText(response, 200, STUDIO_PAGE, 'text/html; charset=utf-8');
      if (request.method === 'GET' && url.pathname === '/livez') return sendJson(response, 200, { ok: true });
      if (request.method === 'GET' && url.pathname === '/healthz') {
        const health = input.healthDiagnostics ? await input.healthDiagnostics() : { ok: true };
        return sendJson(response, health.ok ? 200 : 503, health);
      }
      if (request.method === 'GET' && url.pathname === '/api/runtime') return sendJson(response, 200, input.runtime
        ? { profile: input.deploymentProfile ?? 'external', configured: input.runtime.configured, config: input.runtime.publicConfig, sync: input.runtime.syncStatus }
        : { profile: input.deploymentProfile ?? 'external', configured: true, config: null, sync: input.syncStatus?.() ?? { running: false, started_at: null, completed_at: null, scanned: 0, created: 0, failed: 0, removed: 0, error: null } });
      if (request.method === 'GET' && url.pathname === '/api/metrics') return sendJson(response, 200, await requiredService().metrics());
      if (request.method === 'GET' && url.pathname === '/api/evaluation') return sendJson(response, 200, await requiredService().quality());
      if (request.method === 'GET' && url.pathname === '/api/v1/runtime') return sendJson(response, 200, input.runtime
        ? { profile: input.deploymentProfile ?? 'external', configured: input.runtime.configured, config: input.runtime.publicConfig, sync: input.runtime.syncStatus, capabilities }
        : { profile: input.deploymentProfile ?? 'external', configured: true, config: null, sync: input.syncStatus?.() ?? null, capabilities });
      if (request.method === 'GET' && url.pathname === '/api/v1/doctor') {
        const health = input.healthDiagnostics ? await input.healthDiagnostics() : { ok: true };
        return sendJson(response, health.ok ? 200 : 503, health);
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/scenarios') return sendJson(response, 200, requiredService().scenarios());
      if (request.method === 'GET' && url.pathname === '/api/v1/recordings') return sendJson(response, 200, await requiredService().list());
      if (request.method === 'POST' && url.pathname === '/api/v1/recordings/sync' && (input.runtime || input.syncRecordings)) {
        requireOperator(request);
        return sendJson(response, 200, input.runtime ? await input.runtime.sync() : await input.syncRecordings!());
      }
      if (request.method === 'PUT' && url.pathname === '/api/config' && input.runtime) {
        requireOperator(request, process.env.DEMO_SETUP_TOKEN ?? process.env.DEMO_OPERATOR_TOKEN);
        await input.runtime.configure(await readJson(request));
        return sendJson(response, 200, { configured: true, config: input.runtime.publicConfig });
      }
      if (request.method === 'POST' && url.pathname === '/api/sync' && (input.runtime || input.syncRecordings)) {
        requireOperator(request);
        return sendJson(response, 200, input.runtime ? await input.runtime.sync() : await input.syncRecordings!());
      }
      if (request.method === 'POST' && url.pathname === '/webhooks/voicecan') {
        const secrets = input.runtime?.webhookSecrets ?? input.webhookSecret;
        if (!secrets || Array.isArray(secrets) && secrets.length === 0) throw Object.assign(new Error('STUDIO_NOT_CONFIGURED'), { status: 503 });
        const event = await readVerifiedEvent(request, secrets);
        await requiredService().acceptEvent(event);
        response.writeHead(204).end(); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/jobs') return sendJson(response, 200, await requiredService().list());
      const scenarioMatch = url.pathname.match(/^\/api\/v1\/recordings\/([^/]+)\/scenario(?:\/(confirm|unconfirm|export\.md))?$/);
      if (scenarioMatch) {
        const id = decodeURIComponent(scenarioMatch[1] ?? '');
        const action = scenarioMatch[2];
        const service = requiredService();
        if (request.method === 'GET' && !action) {
          const job = await service.get(id);
          if (!job) return sendJson(response, 404, { error: 'JOB_NOT_FOUND' });
          response.setHeader('etag', `"scenario-${job.scenario_revision}"`);
          return sendJson(response, 200, { scenario_id: job.scenario_id, state: job.scenario_state, current_revision: job.scenario_revision, current: job.scenario_result, confirmation: job.scenario_confirmation, history: job.scenario_revisions });
        }
        if (request.method === 'PUT' && !action) {
          requireOperator(request);
          const body = await readJson(request) as { scenario_id?: string };
          if (!body.scenario_id) throw Object.assign(new Error('SCENARIO_ID_REQUIRED'), { status: 422 });
          return sendJson(response, 200, await service.selectScenario(id, body.scenario_id));
        }
        if (request.method === 'PATCH' && !action) {
          requireOperator(request);
          const job = await service.get(id);
          if (!job) return sendJson(response, 404, { error: 'JOB_NOT_FOUND' });
          const body = await readJson(request) as { result?: ScenarioResultV1; expected_revision?: number; editor?: string; note?: string | null };
          if ((body.expected_revision ?? job.scenario_revision) !== job.scenario_revision) throw Object.assign(new Error('SCENARIO_REVISION_CONFLICT'), { status: 409 });
          if (!body.result) throw Object.assign(new Error('SCENARIO_RESULT_REQUIRED'), { status: 422 });
          return sendJson(response, 200, await service.reviseScenario(id, body.result, body.editor ?? 'api', body.note ?? null));
        }
        if (request.method === 'POST' && action === 'confirm') {
          requireOperator(request);
          const body = await readJson(request).catch(() => ({})) as { actor?: string; note?: string | null };
          return sendJson(response, 200, await service.confirmScenario(id, body.actor ?? 'api', body.note ?? null));
        }
        if (request.method === 'POST' && action === 'unconfirm') { requireOperator(request); return sendJson(response, 200, await service.unconfirmScenario(id)); }
        if (request.method === 'GET' && action === 'export.md') {
          response.setHeader('content-disposition', `attachment; filename="scenario-${id}.md"`);
          return sendText(response, 200, await service.scenarioMarkdown(id), 'text/markdown; charset=utf-8');
        }
      }
      const actionMatch = url.pathname.match(/^\/api\/v1\/recordings\/([^/]+)\/actions(?:\/([^/]+)\/(execute))?$/);
      if (actionMatch) {
        const id = decodeURIComponent(actionMatch[1] ?? '');
        const actionId = actionMatch[2] ? decodeURIComponent(actionMatch[2]) : undefined;
        if (request.method === 'GET' && !actionId) {
          const job = await requiredService().get(id);
          return job ? sendJson(response, 200, job.action_intents) : sendJson(response, 404, { error: 'JOB_NOT_FOUND' });
        }
        if (request.method === 'POST' && !actionId) {
          requireOperator(request);
          const body = await readJson(request) as { target?: NotificationTarget };
          if (!body.target) throw Object.assign(new Error('NOTIFICATION_TARGET_REQUIRED'), { status: 422 });
          return sendJson(response, 201, await requiredService().createActionIntent(id, body.target));
        }
        if (request.method === 'POST' && actionId && actionMatch[3] === 'execute') {
          requireOperator(request);
          return sendJson(response, 202, await requiredService().executeActionIntent(id, actionId));
        }
      }
      const recordingMatch = url.pathname.match(/^\/api\/v1\/recordings\/([^/]+)(?:\/(transcript|summary|deliveries)(?:\/([^/]+))?(?:\/(confirm|unconfirm|generate|export\.md|refresh|cancel))?)?$/);
      if (recordingMatch) {
        const id = decodeURIComponent(recordingMatch[1] ?? '');
        const section = recordingMatch[2];
        const pathChild = recordingMatch[3] ? decodeURIComponent(recordingMatch[3]) : undefined;
        const childId = section === 'deliveries' ? pathChild : undefined;
        const action = recordingMatch[4] ?? (section === 'summary' ? pathChild : undefined);
        const service = requiredService();
        if (request.method === 'GET' && !section) {
          const job = await service.get(id);
          return job ? sendJson(response, 200, job) : sendJson(response, 404, { error: 'JOB_NOT_FOUND' });
        }
        if (section === 'transcript') {
          if (request.method === 'GET') {
            const job = await service.get(id);
            if (!job) return sendJson(response, 404, { error: 'JOB_NOT_FOUND' });
            response.setHeader('etag', `"transcript-${job.transcript_revision}"`);
            return sendJson(response, 200, { current_revision: job.transcript_revision, current: job.transcript, history: job.revisions });
          }
          if (request.method === 'PATCH') {
            requireOperator(request);
            const job = await service.get(id);
            if (!job) return sendJson(response, 404, { error: 'JOB_NOT_FOUND' });
            const body = await readJson(request) as { transcript?: TranscriptV1; expected_revision?: number; editor?: string; note?: string | null };
            const ifMatch = request.headers['if-match'];
            const expected = body.expected_revision ?? (typeof ifMatch === 'string' ? Number(ifMatch.replace(/\D/g, '')) : job.transcript_revision);
            if (expected !== job.transcript_revision) throw Object.assign(new Error('TRANSCRIPT_REVISION_CONFLICT'), { status: 409 });
            if (!body.transcript) throw Object.assign(new Error('TRANSCRIPT_REQUIRED'), { status: 422 });
            return sendJson(response, 200, await service.revise(id, body.transcript, body.editor ?? 'api', body.note ?? null));
          }
        }
        if (section === 'summary') {
          if (request.method === 'GET' && !action) {
            const job = await service.get(id);
            if (!job) return sendJson(response, 404, { error: 'JOB_NOT_FOUND' });
            response.setHeader('etag', `"summary-${job.summary_revision}"`);
            return sendJson(response, 200, { state: job.summary_state, current_revision: job.summary_revision, current: job.summary, history: job.summary_revisions, error_code: job.summary_error_code, error_message: job.summary_error_message });
          }
          if (request.method === 'POST' && action === 'generate') { requireOperator(request); await service.generateSummary(id); return sendJson(response, 202, await service.get(id)); }
          if (request.method === 'PATCH' && !action) {
            requireOperator(request);
            const job = await service.get(id);
            if (!job) return sendJson(response, 404, { error: 'JOB_NOT_FOUND' });
            const body = await readJson(request) as { summary?: MeetingSummaryV1; expected_revision?: number; editor?: string; note?: string | null };
            if ((body.expected_revision ?? job.summary_revision) !== job.summary_revision) throw Object.assign(new Error('SUMMARY_REVISION_CONFLICT'), { status: 409 });
            if (!body.summary) throw Object.assign(new Error('SUMMARY_REQUIRED'), { status: 422 });
            return sendJson(response, 200, await service.reviseSummary(id, body.summary, body.editor ?? 'api', body.note ?? null));
          }
          if (request.method === 'GET' && action === 'export.md') { response.setHeader('content-disposition', `attachment; filename="summary-${id}.md"`); return sendText(response, 200, await service.summaryMarkdown(id), 'text/markdown; charset=utf-8'); }
        }
        if (section === 'deliveries') {
          if (request.method === 'GET' && !childId) { const job = await service.get(id); return job ? sendJson(response, 200, job.deliveries) : sendJson(response, 404, { error: 'JOB_NOT_FOUND' }); }
          if (request.method === 'POST' && childId && action === 'refresh') { requireOperator(request); return sendJson(response, 200, await service.refreshDelivery(id, childId)); }
          if (request.method === 'POST' && childId && action === 'cancel') { requireOperator(request); return sendJson(response, 200, await service.cancelDelivery(id, childId)); }
        }
      }
      const match = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(transcript|retry|cancel|export|audio))?$/);
      if (match) {
        const id = decodeURIComponent(match[1] ?? ''); const action = match[2];
        if (request.method === 'GET' && !action) { const job = await requiredService().get(id); return job ? sendJson(response, 200, job) : sendJson(response, 404, { error: 'JOB_NOT_FOUND' }); }
        if (request.method === 'DELETE' && !action) { requireOperator(request); await requiredService().delete(id); response.writeHead(204).end(); return; }
        if (request.method === 'POST' && action === 'retry') { requireOperator(request); await requiredService().retry(id); return sendJson(response, 202, { accepted: true }); }
        if (request.method === 'POST' && action === 'cancel') { requireOperator(request); await requiredService().cancel(id); return sendJson(response, 202, { canceled: true }); }
        if (request.method === 'PATCH' && action === 'transcript') {
          requireOperator(request);
          const body = await readJson(request) as { transcript?: TranscriptV1; editor?: string; note?: string | null };
          if (!body.transcript) throw Object.assign(new Error('TRANSCRIPT_REQUIRED'), { status: 422 });
          return sendJson(response, 200, await requiredService().revise(id, body.transcript, body.editor ?? 'api', body.note ?? null));
        }
        if (request.method === 'GET' && action === 'export') {
          const format = url.searchParams.get('format');
          if (!['txt', 'json', 'srt'].includes(format ?? '')) throw Object.assign(new Error('EXPORT_FORMAT_INVALID'), { status: 422 });
          const output = await requiredService().export(id, format as 'txt' | 'json' | 'srt');
          response.setHeader('content-disposition', `attachment; filename="${output.filename}"`); return sendText(response, 200, output.body, output.contentType);
        }
        if ((request.method === 'GET' || request.method === 'HEAD') && action === 'audio') return streamAudio(request, response, await requiredService().playback(id));
      }
      sendJson(response, 404, { error: 'NOT_FOUND' });
    } catch (error) { sendJson(response, routeErrorStatus(error), { error: error instanceof Error ? error.message.split(':')[0] : 'REQUEST_FAILED', message: sanitizeError(error) }); }
  });
}
