import type { MeetingSummaryV1, TranscriptionJob } from '../../../shared/contracts.js';

export type SummaryUseCases = {
  generate(recordingId: string): Promise<void>;
  revise(recordingId: string, summary: MeetingSummaryV1, actor: string, note: string | null): Promise<TranscriptionJob>;
  confirm(recordingId: string, actor: string, note: string | null): Promise<TranscriptionJob>;
};
