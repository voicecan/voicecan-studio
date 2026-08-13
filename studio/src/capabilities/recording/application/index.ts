import type { RecordingFile } from '@voicecan/contracts';
import type { TranscriptV1, TranscriptionJob } from '../../../shared/contracts.js';

export type RecordingUseCases = {
  accept(recording: RecordingFile, eventId: string): Promise<TranscriptionJob | null>;
  revise(id: string, transcript: TranscriptV1, actor: string, note: string | null): Promise<TranscriptionJob>;
  reconcile(authorizedIds: ReadonlySet<string>): Promise<number>;
};
