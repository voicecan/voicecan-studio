import type { RecordingFile } from '@voicecan/contracts';
import { VoicecanDeviceServer } from '@voicecan/server-client';
import type { RecordingClient } from '../service.js';

export class VoicecanPlatformAdapter implements RecordingClient {
  readonly #client: VoicecanDeviceServer;

  constructor(input: { baseUrl: string; applicationToken: string; client?: VoicecanDeviceServer }) {
    this.#client = input.client ?? new VoicecanDeviceServer({ baseUrl: input.baseUrl, applicationToken: input.applicationToken });
  }

  get(recordingId: string): Promise<RecordingFile> { return this.#client.recordings.get(recordingId); }

  downloadToFile(recordingId: string, destination: string, options?: Parameters<VoicecanDeviceServer['recordings']['downloadToFile']>[2]): Promise<void> {
    return this.#client.recordings.downloadToFile(recordingId, destination, options);
  }

  listAuthorized(): AsyncGenerator<RecordingFile> { return this.#client.recordings.list({ status: 'synced', limit: 100 }); }
}
