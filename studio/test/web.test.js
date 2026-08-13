import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStudioServer } from '../dist/web.js';

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('Local Full exposes list sync status and an immediate synchronization action', async (context) => {
  let calls = 0;
  let status = { running: false, started_at: null, completed_at: null, scanned: 0, created: 0, failed: 0, removed: 0, error: null };
  const service = { list: async () => [], metrics: async () => ({}), quality: async () => ({}) };
  const server = createStudioServer({
    service,
    deploymentProfile: 'local-full',
    syncStatus: () => ({ ...status }),
    syncRecordings: async () => {
      calls += 1;
      status = { ...status, completed_at: new Date().toISOString(), scanned: 12, created: 2 };
      return { ...status };
    },
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = await listen(server);

  const page = await (await fetch(origin)).text();
  assert.match(page, /id="sync"/);
  assert.match(page, /搜索录音、场景或内容/);
  assert.match(page, /const playbackPositions=new Map/);
  assert.match(page, /audio\.onpause=\(\)=>\{playing=false;rememberPosition\(\)\}/);
  assert.match(page, /querySelectorAll\('\.segment\[data-seek\]'\)/);
  assert.match(page, /id="manual-transcript"/);
  assert.match(page, /没有识别到有效文字。你可以在这里输入或粘贴内容/);
  assert.match(page, /id:'manual-0001'/);
  assert.match(page, /请先输入转写内容/);
  assert.match(page, /summaryRequests=new Set/);
  assert.match(page, /generate\.textContent='处理中…'/);
  assert.match(page, /result\?\.summary_state==='failed'/);
  assert.match(page, /noticeTimer=setTimeout/);
  assert.match(page, /renderedDetailKey!==detailKey\(current\)/);
  assert.match(page, /await load\(\{forceDetail:true\}\)/);
  assert.match(page, /active\.matches\('input,select,textarea'\)/);
  assert.match(page, /<b>处理失败<\/b>/);
  assert.match(page, /skipped:'已跳过'/);
  assert.match(page, /转写没有有效文字，不会调用摘要模型/);
  assert.match(page, /timing\.synced_at.*label:'同步时间'/);
  assert.match(page, /timing\.discovered_at.*label:'发现时间'/);
  assert.match(page, /设备录音时间/);
  assert.match(page, /scenario-sections/);
  assert.match(page, /本场景提取的信息/);
  assert.match(page, /第一次使用 Courier？查看接入步骤/);
  assert.match(page, /Courier 模板 ID/);

  const result = await (await fetch(`${origin}/api/v1/recordings/sync`, { method: 'POST' })).json();
  assert.equal(calls, 1);
  assert.equal(result.scanned, 12);
  assert.equal(result.created, 2);

  const runtime = await (await fetch(`${origin}/api/runtime`)).json();
  assert.equal(runtime.profile, 'local-full');
  assert.equal(runtime.sync.scanned, 12);
});

test('audio endpoint serves deterministic single byte ranges for browser playback', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'transcription-audio-range-'));
  const audioPath = join(root, 'playback.m4a');
  await writeFile(audioPath, Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'));
  const service = {
    list: async () => [], metrics: async () => ({}), quality: async () => ({}),
    playback: async () => ({ path: audioPath, contentType: 'audio/mp4', filename: 'recording.m4a' }),
  };
  const server = createStudioServer({ service, deploymentProfile: 'local-full' });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = await listen(server);

  const response = await fetch(`${origin}/api/jobs/job-1/audio`, { headers: { range: 'bytes=10-19' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-range'), 'bytes 10-19/36');
  assert.equal(response.headers.get('content-length'), '10');
  assert.equal(await response.text(), 'abcdefghij');
});

test('Scenario review and Action Intent API expose the executable application loop', async (context) => {
  const calls = [];
  const job = { id: 'job-1', scenario_id: 'voice-inbox', scenario_state: 'completed', scenario_revision: 1, scenario_result: { title: 'Inbox' }, scenario_confirmation: null, scenario_revisions: [], action_intents: [], deliveries: [] };
  const service = {
    list: async () => [job], metrics: async () => ({}), quality: async () => ({}), get: async () => job,
    scenarios: () => [{ id: 'voice-inbox', version: '1.0.0', title: 'Voice Inbox' }],
    selectScenario: async (_id, scenarioId) => { calls.push(['select', scenarioId]); return { ...job, scenario_id: scenarioId }; },
    reviseScenario: async () => { calls.push(['revise']); return { ...job, scenario_revision: 2 }; },
    confirmScenario: async () => { calls.push(['confirm']); return { ...job, scenario_confirmation: { scenario_revision: 1 } }; },
    unconfirmScenario: async () => job,
    scenarioMarkdown: async () => '# Inbox',
    createActionIntent: async () => { calls.push(['create-action']); return { id: 'action-1', state: 'draft' }; },
    executeActionIntent: async (_id, actionId) => { calls.push(['execute', actionId]); return { id: actionId, state: 'submitted' }; },
  };
  const server = createStudioServer({ service, deploymentProfile: 'external' });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = await listen(server);

  assert.equal((await (await fetch(`${origin}/api/v1/scenarios`)).json())[0].id, 'voice-inbox');
  assert.equal((await (await fetch(`${origin}/api/v1/recordings/job-1/scenario`)).json()).current_revision, 1);
  await fetch(`${origin}/api/v1/recordings/job-1/scenario`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario_id: 'field-report' }) });
  await fetch(`${origin}/api/v1/recordings/job-1/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { id: 'ops' } }) });
  await fetch(`${origin}/api/v1/recordings/job-1/actions/action-1/execute`, { method: 'POST' });
  assert.deepEqual(calls, [['select', 'field-report'], ['create-action'], ['execute', 'action-1']]);
});
