import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type EventClaim = 'claimed' | 'duplicate' | 'tombstoned';

export type OutboxEntry = {
  id: string;
  topic: string;
  aggregate_id: string;
  idempotency_key: string;
  payload: unknown;
  attempt: number;
  available_at: string;
  created_at: string;
  last_error: string | null;
};

function now(): string { return new Date().toISOString(); }

function acquireRuntimeLock(databasePath: string): void {
  const lockPath = `${databasePath}.runtime.lock`;
  const create = (): void => writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, database_path: databasePath, created_at: now() })}\n`, { flag: 'wx', mode: 0o600 });
  try { create(); return; }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  let owner = 0;
  try { owner = Number((JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown }).pid); } catch { owner = 0; }
  if (owner === process.pid) return;
  if (Number.isSafeInteger(owner) && owner > 0) {
    try { process.kill(owner, 0); throw Object.assign(new Error('STUDIO_RUNTIME_LOCKED'), { owner_pid: owner }); }
    catch (error) {
      if (error instanceof Error && error.message === 'STUDIO_RUNTIME_LOCKED') throw error;
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') throw Object.assign(new Error('STUDIO_RUNTIME_LOCKED'), { owner_pid: owner });
    }
  }
  unlinkSync(lockPath);
  create();
}

/** Single-process transactional application store. */
export class SqliteStore<T extends { id: string }> {
  readonly #path: string;
  readonly #db: DatabaseSync;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = resolve(path);
    // The parent normally exists after first write. Synchronous construction is
    // intentional so no caller can observe a half-initialized store.
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    acquireRuntimeLock(this.#path);
    this.#db = new DatabaseSync(this.#path);
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS studio_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO studio_schema_migrations(version,name,applied_at) VALUES(1,'unified-studio-v1',datetime('now'));
      CREATE TABLE IF NOT EXISTS studio_recordings (
        id TEXT PRIMARY KEY,
        resource_version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        current_transcript_revision INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS studio_transcript_revisions (
        recording_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(recording_id,revision),
        UNIQUE(recording_id,content_hash),
        FOREIGN KEY(recording_id) REFERENCES studio_recordings(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS studio_summary_revisions (
        recording_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        transcript_revision INTEGER NOT NULL,
        input_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('completed','stale')),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(recording_id,revision),
        UNIQUE(recording_id,input_key),
        FOREIGN KEY(recording_id,transcript_revision) REFERENCES studio_transcript_revisions(recording_id,revision) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS studio_artifacts (
        id TEXT PRIMARY KEY,
        recording_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('transcript','summary','scenario-result')),
        schema_version TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        parent_ids_json TEXT NOT NULL,
        producer_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
        created_at TEXT NOT NULL,
        FOREIGN KEY(recording_id) REFERENCES studio_recordings(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS studio_scenario_revisions (
        recording_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        scenario_id TEXT NOT NULL,
        transcript_revision INTEGER NOT NULL,
        summary_revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('completed','stale')),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(recording_id,revision),
        FOREIGN KEY(recording_id,transcript_revision) REFERENCES studio_transcript_revisions(recording_id,revision) ON DELETE CASCADE,
        FOREIGN KEY(recording_id,summary_revision) REFERENCES studio_summary_revisions(recording_id,revision) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS studio_scenario_confirmations (
        recording_id TEXT NOT NULL,
        scenario_revision INTEGER NOT NULL,
        actor TEXT NOT NULL,
        note TEXT,
        confirmed_at TEXT NOT NULL,
        PRIMARY KEY(recording_id,scenario_revision),
        FOREIGN KEY(recording_id,scenario_revision) REFERENCES studio_scenario_revisions(recording_id,revision) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS studio_notification_connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider='courier'),
        version INTEGER NOT NULL CHECK(version > 0),
        config_json TEXT NOT NULL,
        secret_reference TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(id,version)
      );
      CREATE TABLE IF NOT EXISTS studio_notification_targets (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK(version > 0),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(id,version)
      );
      CREATE TABLE IF NOT EXISTS studio_delivery_intents (
        id TEXT PRIMARY KEY,
        recording_id TEXT NOT NULL,
        summary_revision INTEGER NOT NULL,
        target_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('pending','submitting','accepted','delivered','failed','canceled','unknown')),
        payload_json TEXT NOT NULL,
        provider_request_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(recording_id,summary_revision) REFERENCES studio_summary_revisions(recording_id,revision),
        FOREIGN KEY(target_id) REFERENCES studio_notification_targets(id)
      );
      CREATE TABLE IF NOT EXISTS studio_action_intents (
        id TEXT PRIMARY KEY,
        recording_id TEXT NOT NULL,
        scenario_revision INTEGER NOT NULL,
        target_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('draft','executing','submitted','completed','failed','canceled')),
        preview_json TEXT NOT NULL,
        delivery_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(recording_id,scenario_revision) REFERENCES studio_scenario_revisions(recording_id,revision),
        FOREIGN KEY(target_id) REFERENCES studio_notification_targets(id)
      );
      CREATE TABLE IF NOT EXISTS demo_items (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_inbox (
        event_id TEXT PRIMARY KEY,
        event_hash TEXT NOT NULL,
        event_type TEXT NOT NULL,
        recording_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('processing','completed','failed')),
        received_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS recording_tombstones (
        recording_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        event_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS demo_outbox (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS demo_metrics (
        name TEXT PRIMARY KEY,
        value REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async list(): Promise<T[]> {
    await this.#queue;
    return this.#readItems();
  }

  async get(id: string): Promise<T | undefined> {
    await this.#queue;
    const row = this.#db.prepare('SELECT payload FROM demo_items WHERE id=?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as T : undefined;
  }

  update<R>(operation: (items: T[]) => R | Promise<R>): Promise<R> {
    const task = this.#queue.then(async () => {
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const items = this.#readItems();
        const result = await operation(items);
        this.#replaceItems(items);
        this.#db.exec('COMMIT');
        return result;
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    });
    this.#queue = task.catch(() => undefined);
    return task;
  }

  claimEvent(input: { id: string; type: string; recordingId?: string; payload: unknown }): Promise<EventClaim> {
    return this.#serialize(() => {
      const hash = createHash('sha256').update(JSON.stringify(input.payload)).digest('hex');
      const existing = this.#db.prepare('SELECT event_hash,status FROM event_inbox WHERE event_id=?').get(input.id) as { event_hash: string; status: string } | undefined;
      if (existing && existing.event_hash !== hash) throw Object.assign(new Error('EVENT_ID_COLLISION'), { status: 409 });
      if (input.recordingId && this.hasTombstoneSync(input.recordingId)) return 'tombstoned';
      if (existing?.status === 'completed' || existing?.status === 'processing') return 'duplicate';
      const timestamp = now();
      this.#db.prepare(`INSERT INTO event_inbox(event_id,event_hash,event_type,recording_id,status,received_at,updated_at,last_error)
        VALUES(?,?,?,?, 'processing',?,?,NULL)
        ON CONFLICT(event_id) DO UPDATE SET status='processing',updated_at=excluded.updated_at,last_error=NULL`).run(
        input.id, hash, input.type, input.recordingId ?? null, timestamp, timestamp,
      );
      return 'claimed';
    });
  }

  completeEvent(eventId: string): Promise<void> {
    return this.#serialize(() => { this.#db.prepare("UPDATE event_inbox SET status='completed',updated_at=?,last_error=NULL WHERE event_id=?").run(now(), eventId); });
  }

  failEvent(eventId: string, message: string): Promise<void> {
    return this.#serialize(() => { this.#db.prepare("UPDATE event_inbox SET status='failed',updated_at=?,last_error=? WHERE event_id=?").run(now(), message.slice(0, 400), eventId); });
  }

  addTombstone(recordingId: string, reason: string, eventId?: string): Promise<void> {
    return this.#serialize(() => {
      this.#db.prepare(`INSERT INTO recording_tombstones(recording_id,reason,event_id,created_at) VALUES(?,?,?,?)
        ON CONFLICT(recording_id) DO UPDATE SET reason=excluded.reason,event_id=excluded.event_id,created_at=excluded.created_at`).run(recordingId, reason, eventId ?? null, now());
    });
  }

  hasTombstone(recordingId: string): Promise<boolean> {
    return this.#serialize(() => this.hasTombstoneSync(recordingId));
  }

  enqueueOutbox(input: { topic: string; aggregateId: string; idempotencyKey: string; payload: unknown }): Promise<void> {
    return this.#serialize(() => {
      const timestamp = now();
      this.#db.prepare(`INSERT INTO demo_outbox(id,topic,aggregate_id,idempotency_key,payload,attempt,available_at,created_at)
        VALUES(?,?,?,?,?,0,?,?) ON CONFLICT(idempotency_key) DO NOTHING`).run(
        crypto.randomUUID(), input.topic, input.aggregateId, input.idempotencyKey, JSON.stringify(input.payload), timestamp, timestamp,
      );
    });
  }

  pendingOutbox(limit = 50): Promise<OutboxEntry[]> {
    return this.#serialize(() => {
      const rows = this.#db.prepare(`SELECT id,topic,aggregate_id,idempotency_key,payload,attempt,available_at,created_at,last_error
        FROM demo_outbox WHERE delivered_at IS NULL AND available_at<=? ORDER BY created_at LIMIT ?`).all(now(), limit) as Array<Omit<OutboxEntry, 'payload'> & { payload: string }>;
      return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
    });
  }

  completeOutbox(id: string): Promise<void> {
    return this.#serialize(() => { this.#db.prepare('UPDATE demo_outbox SET delivered_at=?,last_error=NULL WHERE id=?').run(now(), id); });
  }

  failOutbox(id: string, message: string): Promise<void> {
    return this.#serialize(() => {
      const row = this.#db.prepare('SELECT attempt FROM demo_outbox WHERE id=?').get(id) as { attempt: number } | undefined;
      const attempt = (row?.attempt ?? 0) + 1;
      const delay = Math.min(3_600_000, 1_000 * 2 ** Math.min(attempt, 12));
      this.#db.prepare('UPDATE demo_outbox SET attempt=?,available_at=?,last_error=? WHERE id=?').run(attempt, new Date(Date.now() + delay).toISOString(), message.slice(0, 400), id);
    });
  }

  metric(name: string, delta = 1): Promise<void> {
    return this.#serialize(() => {
      this.#db.prepare(`INSERT INTO demo_metrics(name,value,updated_at) VALUES(?,?,?)
        ON CONFLICT(name) DO UPDATE SET value=demo_metrics.value+excluded.value,updated_at=excluded.updated_at`).run(name, delta, now());
    });
  }

  metrics(): Promise<Record<string, number>> {
    return this.#serialize(() => Object.fromEntries((this.#db.prepare('SELECT name,value FROM demo_metrics ORDER BY name').all() as Array<{ name: string; value: number }>).map((row) => [row.name, row.value])));
  }

  async close(): Promise<void> {
    await this.#queue;
    this.#db.close();
  }

  #serialize<R>(operation: () => R | Promise<R>): Promise<R> {
    const task = this.#queue.then(operation);
    this.#queue = task.catch(() => undefined);
    return task;
  }

  #readItems(): T[] {
    return (this.#db.prepare('SELECT payload FROM demo_items ORDER BY rowid').all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as T);
  }

  #replaceItems(items: T[]): void {
    this.#db.exec('DELETE FROM demo_items');
    const insert = this.#db.prepare('INSERT INTO demo_items(id,payload,updated_at) VALUES(?,?,?)');
    const timestamp = now();
    for (const item of items) insert.run(item.id, JSON.stringify(item), timestamp);
    this.#replaceStudioProjection(items, timestamp);
  }

  #replaceStudioProjection(items: T[], timestamp: string): void {
    const jobs = items.map((item) => item as unknown as Record<string, unknown>).filter((item) => typeof item.recording_id === 'string' && item.recording && typeof item.recording === 'object');
    if (jobs.length !== items.length) return;
    this.#db.exec(`
      DELETE FROM studio_action_intents;
      DELETE FROM studio_delivery_intents;
      DELETE FROM studio_scenario_confirmations;
      DELETE FROM studio_scenario_revisions;
      DELETE FROM studio_artifacts;
      DELETE FROM studio_summary_revisions;
      DELETE FROM studio_transcript_revisions;
      DELETE FROM studio_notification_targets;
      DELETE FROM studio_recordings;
    `);
    const recordingInsert = this.#db.prepare('INSERT INTO studio_recordings(id,resource_version,snapshot_json,current_transcript_revision,created_at,updated_at) VALUES(?,?,?,?,?,?)');
    const transcriptInsert = this.#db.prepare('INSERT INTO studio_transcript_revisions(recording_id,revision,content_hash,payload_json,created_at) VALUES(?,?,?,?,?)');
    const summaryInsert = this.#db.prepare("INSERT INTO studio_summary_revisions(recording_id,revision,transcript_revision,input_key,state,payload_json,created_at) VALUES(?,?,?,?,?,?,?)");
    const targetInsert = this.#db.prepare('INSERT OR IGNORE INTO studio_notification_targets(id,version,payload_json,created_at) VALUES(?,?,?,?)');
    const deliveryInsert = this.#db.prepare('INSERT INTO studio_delivery_intents(id,recording_id,summary_revision,target_id,idempotency_key,state,payload_json,provider_request_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const artifactInsert = this.#db.prepare('INSERT INTO studio_artifacts(id,recording_id,kind,schema_version,revision,parent_ids_json,producer_json,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    const scenarioInsert = this.#db.prepare('INSERT INTO studio_scenario_revisions(recording_id,revision,scenario_id,transcript_revision,summary_revision,state,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)');
    const scenarioConfirmationInsert = this.#db.prepare('INSERT INTO studio_scenario_confirmations(recording_id,scenario_revision,actor,note,confirmed_at) VALUES(?,?,?,?,?)');
    const actionInsert = this.#db.prepare('INSERT INTO studio_action_intents(id,recording_id,scenario_revision,target_id,idempotency_key,state,preview_json,delivery_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    for (const job of jobs) {
      const recordingId = String(job.recording_id);
      const recording = job.recording as Record<string, unknown>;
      const currentTranscriptRevision = Number(job.transcript_revision ?? 0);
      recordingInsert.run(recordingId, Number(recording.resource_version ?? 1), JSON.stringify(recording), currentTranscriptRevision > 0 ? currentTranscriptRevision : null, String(job.created_at ?? timestamp), String(job.updated_at ?? timestamp));
      const transcriptRows: Array<{ revision: number; value: unknown; createdAt: string }> = [];
      if (Array.isArray(job.revisions)) for (const raw of job.revisions) {
        if (!raw || typeof raw !== 'object') continue;
        const revision = raw as Record<string, unknown>;
        transcriptRows.push({ revision: Number(revision.revision), value: revision.value, createdAt: String(revision.edited_at ?? timestamp) });
      }
      if (job.transcript && currentTranscriptRevision > 0) transcriptRows.push({ revision: currentTranscriptRevision, value: job.transcript, createdAt: String(job.updated_at ?? timestamp) });
      const seenTranscript = new Set<number>();
      for (const row of transcriptRows.sort((left, right) => left.revision - right.revision)) {
        if (!Number.isSafeInteger(row.revision) || row.revision < 1 || seenTranscript.has(row.revision)) continue;
        seenTranscript.add(row.revision);
        transcriptInsert.run(recordingId, row.revision, createHash('sha256').update(JSON.stringify(row.value)).digest('hex'), JSON.stringify(row.value), row.createdAt);
      }
      if (Array.isArray(job.summary_revisions)) for (const raw of job.summary_revisions) {
        if (!raw || typeof raw !== 'object') continue;
        const revision = raw as Record<string, unknown>;
        const sourceRevision = Number(revision.source_transcript_revision);
        if (!seenTranscript.has(sourceRevision)) continue;
        const isCurrent = Number(job.summary_revision) === Number(revision.revision);
        const state = isCurrent && job.summary_state === 'stale' ? 'stale' : 'completed';
        summaryInsert.run(recordingId, Number(revision.revision), sourceRevision, String(revision.input_key), state, JSON.stringify(revision.value), String(revision.created_at ?? timestamp));
      }
      if (Array.isArray(job.artifacts)) for (const raw of job.artifacts) {
        if (!raw || typeof raw !== 'object') continue;
        const artifact = raw as Record<string, unknown>;
        artifactInsert.run(String(artifact.id), recordingId, String(artifact.kind), String(artifact.schema_version), Number(artifact.revision), JSON.stringify(artifact.parent_artifact_ids ?? []), JSON.stringify(artifact.producer ?? {}), String(artifact.payload_hash), String(artifact.created_at ?? timestamp));
      }
      if (Array.isArray(job.scenario_revisions)) for (const raw of job.scenario_revisions) {
        if (!raw || typeof raw !== 'object') continue;
        const revision = raw as Record<string, unknown>;
        const value = revision.value as Record<string, unknown>;
        const isCurrent = Number(job.scenario_revision) === Number(revision.revision);
        scenarioInsert.run(recordingId, Number(revision.revision), String(value.scenario_id), Number(value.source_transcript_revision), Number(value.source_summary_revision), isCurrent && job.scenario_state === 'stale' ? 'stale' : 'completed', JSON.stringify(value), String(revision.created_at ?? timestamp));
      }
      if (job.scenario_confirmation && typeof job.scenario_confirmation === 'object') {
        const confirmation = job.scenario_confirmation as Record<string, unknown>;
        scenarioConfirmationInsert.run(recordingId, Number(confirmation.scenario_revision), String(confirmation.confirmed_by), typeof confirmation.note === 'string' ? confirmation.note : null, String(confirmation.confirmed_at));
      }
      if (Array.isArray(job.action_intents)) for (const raw of job.action_intents) {
        if (!raw || typeof raw !== 'object') continue;
        const action = raw as Record<string, unknown>;
        const target = action.target as Record<string, unknown>;
        targetInsert.run(String(target.id), Number(target.version), JSON.stringify(target), String(action.created_at ?? timestamp));
        actionInsert.run(String(action.id), recordingId, Number(action.scenario_revision), String(target.id), String(action.idempotency_key), String(action.state), JSON.stringify(action.preview), typeof action.delivery_id === 'string' ? action.delivery_id : null, String(action.created_at ?? timestamp), String(action.updated_at ?? timestamp));
      }
      if (Array.isArray(job.deliveries)) for (const raw of job.deliveries) {
        if (!raw || typeof raw !== 'object') continue;
        const delivery = raw as Record<string, unknown>;
        const target = delivery.target as Record<string, unknown>;
        targetInsert.run(String(target.id), Number(target.version), JSON.stringify(target), String(delivery.created_at ?? timestamp));
        deliveryInsert.run(
          String(delivery.id),
          recordingId,
          Number(delivery.summary_revision),
          String(target.id),
          String(delivery.idempotency_key),
          String(delivery.state),
          JSON.stringify(delivery.payload),
          typeof delivery.provider_request_id === 'string' ? delivery.provider_request_id : null,
          String(delivery.created_at ?? timestamp),
          String(delivery.updated_at ?? timestamp),
        );
      }
    }
  }

  private hasTombstoneSync(recordingId: string): boolean {
    return Boolean(this.#db.prepare('SELECT 1 FROM recording_tombstones WHERE recording_id=?').get(recordingId));
  }
}
