import type { MeetingSummaryV1, ScenarioResultV1 } from '../shared/contracts.js';
import type { ScenarioBuildInput, ScenarioDefinition } from './types.js';

function refs(summary: MeetingSummaryV1): string[] {
  return [...new Set([
    ...summary.topics.flatMap((item) => item.segment_refs),
    ...summary.decisions.flatMap((item) => item.segment_refs),
    ...summary.action_items.flatMap((item) => item.segment_refs),
  ])];
}

function common(input: ScenarioBuildInput, definition: ScenarioDefinition, values: ScenarioResultV1['values'], sections: ScenarioResultV1['sections']): ScenarioResultV1 {
  return {
    schema_version: 'studio.scenario-result.v1', scenario_id: definition.manifest.id, scenario_version: definition.manifest.version,
    recording_id: input.recording.id, title: input.summary.title, overview: input.summary.overview, values, sections,
    actions: input.summary.action_items.map((item, index) => ({
      id: `action-${index + 1}`, title: item.text.slice(0, 120), description: item.text, assignee: item.assignee, due_at: item.due_at,
      priority: item.due_at ? 'high' : 'medium', segment_refs: item.segment_refs,
    })),
    source_transcript_revision: input.transcriptRevision, source_summary_revision: input.summaryRevision,
  };
}

export const voiceInboxScenario: ScenarioDefinition = {
  manifest: {
    id: 'voice-inbox', version: '1.1.0', title: '语音收件箱', description: '把随手录音整理为备忘、任务和后续动作。',
    default_for_attributes: [0], processor_stages: ['transcription', 'summarization', 'structured-projection'],
    fields: [
      { key: 'category', label: '分类', type: 'string', required: true },
      { key: 'task_count', label: '任务数', type: 'number', required: true },
      { key: 'tags', label: '标签', type: 'string-list', required: true },
    ], allowed_actions: ['courier.notify'],
  },
  build(input) {
    const category = input.summary.action_items.length > 0 ? 'task-note' : input.summary.decisions.length > 0 ? 'decision-note' : 'memo';
    const result = common(input, voiceInboxScenario, {
      category,
      task_count: input.summary.action_items.length,
      tags: [...new Set(input.summary.topics.map((item) => item.title).filter(Boolean))],
    }, [
      { id: 'notes', title: '速记要点', items: input.summary.topics.map((item) => ({ text: `${item.title}：${item.summary}`, segment_refs: item.segment_refs })) },
      { id: 'tasks', title: '待办清单', items: input.summary.action_items.map((item) => ({ text: item.assignee ? `${item.text}（负责人：${item.assignee}）` : item.text, segment_refs: item.segment_refs })) },
      { id: 'decisions', title: '已记录决定', items: input.summary.decisions },
    ]);
    return { ...result, title: `语音备忘：${input.summary.title}` };
  },
};

export const fieldReportScenario: ScenarioDefinition = {
  manifest: {
    id: 'field-report', version: '1.1.0', title: '现场报告', description: '把现场录音整理为结构化巡检或维修报告。',
    default_for_attributes: [1], processor_stages: ['transcription', 'redaction-ready', 'summarization', 'field-report-projection'],
    fields: [
      { key: 'equipment_id', label: '来源设备', type: 'string', required: true },
      { key: 'severity', label: '严重度', type: 'string', required: true },
      { key: 'finding_count', label: '发现数', type: 'number', required: true },
      { key: 'requires_follow_up', label: '需要跟进', type: 'boolean', required: true },
    ], allowed_actions: ['courier.notify'],
  },
  build(input) {
    const text = input.transcript.text.toLowerCase();
    const severity = /危险|严重|紧急|critical|danger/.test(text) ? 'high' : /警告|异常|warning|issue/.test(text) ? 'medium' : 'low';
    const result = common(input, fieldReportScenario, {
      equipment_id: input.recording.device_id, severity, finding_count: input.summary.topics.length,
      requires_follow_up: input.summary.action_items.length > 0 || severity !== 'low',
    }, [
      { id: 'findings', title: '现场发现', items: input.summary.topics.map((item) => ({ text: `${item.title}：${item.summary}`, segment_refs: item.segment_refs })) },
      { id: 'conclusions', title: '处理结论', items: input.summary.decisions },
      { id: 'follow-up', title: '后续处理', items: input.summary.action_items.map((item) => ({ text: item.assignee ? `${item.text}（负责人：${item.assignee}）` : item.text, segment_refs: item.segment_refs })) },
    ]);
    return {
      ...result,
      title: `现场报告：${input.summary.title}`,
      actions: result.actions.map((item) => ({ ...item, priority: severity === 'high' ? 'high' : item.priority })),
    };
  },
};

export const meetingInterviewScenario: ScenarioDefinition = {
  manifest: {
    id: 'meeting-interview', version: '1.1.0', title: '会议 / 访谈', description: '生成带原文引用的议题、观点、决策与行动项。',
    default_for_attributes: [2], processor_stages: ['transcription', 'diarization-ready', 'chunked-summarization', 'traceable-projection'],
    fields: [
      { key: 'topic_count', label: '议题数', type: 'number', required: true },
      { key: 'decision_count', label: '决策数', type: 'number', required: true },
      { key: 'action_count', label: '行动项数', type: 'number', required: true },
      { key: 'source_segments', label: '引用片段', type: 'number', required: true },
    ], allowed_actions: ['courier.notify'],
  },
  build(input) {
    const result = common(input, meetingInterviewScenario, {
      topic_count: input.summary.topics.length, decision_count: input.summary.decisions.length,
      action_count: input.summary.action_items.length, source_segments: refs(input.summary).length,
    }, [
      { id: 'topics', title: '议题与观点', items: input.summary.topics.map((item) => ({ text: `${item.title}：${item.summary}`, segment_refs: item.segment_refs })) },
      { id: 'decisions', title: '已确认决策', items: input.summary.decisions },
      { id: 'actions', title: '行动项与负责人', items: input.summary.action_items.map((item) => ({ text: item.assignee ? `${item.text}（负责人：${item.assignee}）` : item.text, segment_refs: item.segment_refs })) },
    ]);
    return { ...result, title: `会议纪要：${input.summary.title}` };
  },
};

export const builtinScenarios = [voiceInboxScenario, fieldReportScenario, meetingInterviewScenario] as const;
