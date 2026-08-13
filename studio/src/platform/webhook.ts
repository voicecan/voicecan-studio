import type { DeviceEvent } from '@voicecan/contracts';
import { parseVerifiedDeviceEvent } from '@voicecan/server-client';

export function parseVoicecanWebhook(input: { rawBody: Buffer; headers: Record<string, string | string[] | undefined>; secrets: readonly string[] }): DeviceEvent {
  return parseVerifiedDeviceEvent(input);
}
