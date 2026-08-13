import { access, mkdir, rm, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { RecordingMediaDescriptor } from '@voicecan/contracts';
import type { TranscriptV1 } from './contracts.js';

export const SUPPORTED_MEDIA = new Set([
  'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg',
]);

export const DEFAULT_LC3_MEDIA: RecordingMediaDescriptor = {
  schema_version: 'recording.media.v1',
  container: 'lc3',
  codec: 'lc3',
  content_type: 'audio/lc3',
  filename_extension: 'lc3',
  sample_rate_hz: 16_000,
  channels: 1,
  bit_depth: null,
  duration_ms: null,
  encoding_profile: 'voicecan-lc3-v1',
  source: 'firmware_mapping',
};

export function isKnownMedia(media: RecordingMediaDescriptor): boolean {
  return SUPPORTED_MEDIA.has(media.content_type)
    || media.content_type === 'audio/lc3'
    || Boolean(media.codec && media.container);
}

export function mediaWithLc3Default(media: RecordingMediaDescriptor): RecordingMediaDescriptor {
  if (isKnownMedia(media)) return media;
  return {
    ...DEFAULT_LC3_MEDIA,
    duration_ms: media.duration_ms,
  };
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
}

export async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export async function removeSensitiveFile(path: string | null): Promise<void> {
  if (path) await rm(path, { force: true });
}

export async function storageDiagnostics(path: string): Promise<{ total_bytes: number; free_bytes: number; used_ratio: number }> {
  await mkdir(resolve(path), { recursive: true, mode: 0o700 });
  const value = await statfs(resolve(path)); const total = Number(value.blocks) * Number(value.bsize); const free = Number(value.bavail) * Number(value.bsize);
  return { total_bytes: total, free_bytes: free, used_ratio: total > 0 ? (total - free) / total : 0 };
}

function timestamp(milliseconds: number, separator: ',' | '.'): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
}

export function transcriptToSrt(transcript: TranscriptV1): string {
  return transcript.segments.map((segment, index) => `${index + 1}\n${timestamp(segment.start_ms, ',')} --> ${timestamp(segment.end_ms, ',')}\n${segment.speaker ? `${segment.speaker}: ` : ''}${segment.text}\n`).join('\n');
}

export function transcriptToText(transcript: TranscriptV1): string {
  return `${transcript.text.trim()}\n`;
}

