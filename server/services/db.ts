import fs from 'fs';
import path from 'path';
import { JobRecord, DialogueSegment, ContactRecord, NewContact } from '../types.js';
import { logger } from '../utils/logger.js';
import { getStorage } from './storage.js';

export interface DatabaseProvider {
  createJob(job: JobRecord): Promise<JobRecord>;
  getJob(id: string): Promise<JobRecord | null>;
  updateJob(id: string, updates: Partial<JobRecord>): Promise<JobRecord | null>;
  listJobs(limit?: number): Promise<JobRecord[]>;
  deleteJob(id: string): Promise<boolean>;
  saveSegments(jobId: string, segments: DialogueSegment[]): Promise<void>;
  getSegments(jobId: string): Promise<DialogueSegment[]>;
  /**
   * Store a user who contacted us. Repeats from the same email update the
   * existing record instead of piling up duplicates.
   */
  saveContact(input: NewContact): Promise<ContactRecord>;
  listContacts(limit?: number): Promise<ContactRecord[]>;
  /**
   * Merge in the snapshot kept in remote storage. The server calls this on boot
   * so job history survives hosts with an ephemeral disk (e.g. Render free).
   */
  hydrateFromRemote(): Promise<void>;
  /** Upload any queued state now (called on shutdown). */
  flushRemote(): Promise<void>;
}

export class JsonFileDatabaseProvider implements DatabaseProvider {
  private dbPath: string;
  private jobs: Map<string, JobRecord> = new Map();
  private segments: Map<string, DialogueSegment[]> = new Map();
  private contacts: Map<string, ContactRecord> = new Map();

  private stateKey: string;
  private remoteTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteFlush: Promise<void> = Promise.resolve();

  constructor(
    filePath: string = path.join(process.cwd(), 'data', 'db.json'),
    stateKey: string = 'db.json'
  ) {
    this.dbPath = filePath;
    this.stateKey = stateKey;
    this.init();
  }

  private init() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(this.dbPath)) {
      try {
        const raw = fs.readFileSync(this.dbPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.jobs && Array.isArray(parsed.jobs)) {
          parsed.jobs.forEach((j: JobRecord) => this.jobs.set(j.id, j));
        }
        if (parsed.segments) {
          Object.entries(parsed.segments).forEach(([id, segs]) => {
            this.segments.set(id, segs as DialogueSegment[]);
          });
        }
        if (parsed.contacts && Array.isArray(parsed.contacts)) {
          parsed.contacts.forEach((c: ContactRecord) => this.contacts.set(c.id, c));
        }
        logger.info(
          `Loaded ${this.jobs.size} jobs and ${this.contacts.size} user contact(s) from database store`
        );
      } catch (err) {
        logger.warn('Failed to parse database file, initializing empty store:', err);
      }
    }
  }

  private snapshot(): string {
    return JSON.stringify(
      {
        jobs: Array.from(this.jobs.values()),
        segments: Object.fromEntries(this.segments.entries()),
        contacts: Array.from(this.contacts.values()),
      },
      null,
      2
    );
  }

  private persist() {
    try {
      fs.writeFileSync(this.dbPath, this.snapshot(), 'utf8');
    } catch (e) {
      logger.error('Failed to persist database store:', e);
    }
    this.scheduleRemoteSync();
  }

  /** Coalesce bursts of updates into one upload; the local file is always current. */
  private scheduleRemoteSync() {
    if (this.remoteTimer) return;
    this.remoteTimer = setTimeout(() => {
      this.remoteTimer = null;
      this.remoteFlush = this.pushRemote().catch((err) =>
        logger.warn('Failed to sync database store to remote storage:', err)
      );
    }, 1000);
    this.remoteTimer.unref?.();
  }

  private async pushRemote(): Promise<void> {
    await getStorage().setState(this.stateKey, this.snapshot());
  }

  /** Wait for any queued upload — used on shutdown so the last update is not lost. */
  async flushRemote(): Promise<void> {
    if (this.remoteTimer) {
      clearTimeout(this.remoteTimer);
      this.remoteTimer = null;
    }
    await this.pushRemote().catch((err) =>
      logger.warn('Failed to flush database store to remote storage:', err)
    );
    await this.remoteFlush;
  }

  async hydrateFromRemote(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await getStorage().getState(this.stateKey);
    } catch (err) {
      logger.warn('Could not read the remote database store:', err);
      return;
    }
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      let added = 0;
      for (const job of (parsed.jobs || []) as JobRecord[]) {
        const local = this.jobs.get(job.id);
        // Keep whichever copy is further along: a finished job beats a stale
        // "processing" record left over from a process that was killed.
        if (!local || (isTerminal(job.status) && !isTerminal(local.status))) {
          this.jobs.set(job.id, job);
          added++;
        }
      }
      for (const [id, segs] of Object.entries(parsed.segments || {})) {
        if (!this.segments.has(id)) this.segments.set(id, segs as DialogueSegment[]);
      }
      for (const contact of (parsed.contacts || []) as ContactRecord[]) {
        const local = this.contacts.get(contact.id);
        const isNewer =
          !local ||
          new Date(contact.updatedAt || contact.createdAt).getTime() >
            new Date(local.updatedAt || local.createdAt).getTime();
        if (isNewer) {
          this.contacts.set(contact.id, contact);
          added++;
        }
      }
      if (added > 0) {
        logger.info(`Recovered ${added} job(s) from remote storage`);
        fs.writeFileSync(this.dbPath, this.snapshot(), 'utf8');
      }
    } catch (err) {
      logger.warn('Failed to parse the remote database store:', err);
    }
  }

  async createJob(job: JobRecord): Promise<JobRecord> {
    this.jobs.set(job.id, { ...job });
    this.persist();
    return job;
  }

  async getJob(id: string): Promise<JobRecord | null> {
    return this.jobs.get(id) || null;
  }

  async updateJob(id: string, updates: Partial<JobRecord>): Promise<JobRecord | null> {
    const existing = this.jobs.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      ...updates,
    };
    this.jobs.set(id, updated);
    this.persist();
    return updated;
  }

  async listJobs(limit: number = 50): Promise<JobRecord[]> {
    const all = Array.from(this.jobs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return all.slice(0, limit);
  }

  async deleteJob(id: string): Promise<boolean> {
    const deleted = this.jobs.delete(id);
    this.segments.delete(id);
    if (deleted) this.persist();
    return deleted;
  }

  async saveSegments(jobId: string, segments: DialogueSegment[]): Promise<void> {
    this.segments.set(jobId, segments);
    const job = this.jobs.get(jobId);
    if (job) {
      job.segments = segments;
      this.persist();
    }
  }

  async getSegments(jobId: string): Promise<DialogueSegment[]> {
    return this.segments.get(jobId) || [];
  }

  async saveContact(input: NewContact): Promise<ContactRecord> {
    const email = input.email.trim().toLowerCase();
    const name = input.name.trim();
    const now = new Date().toISOString();
    const existing = Array.from(this.contacts.values()).find((c) => c.email === email);

    const record: ContactRecord = existing
      ? {
          ...existing,
          name: name || existing.name,
          message: input.message?.trim() ? input.message.trim() : existing.message,
          plan: input.plan || existing.plan,
          deviceId: input.deviceId || existing.deviceId,
          times: (existing.times || 1) + 1,
          updatedAt: now,
        }
      : {
          id: `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          name,
          email,
          message: input.message?.trim() || '',
          plan: input.plan || 'free',
          source: input.source || 'welcome',
          deviceId: input.deviceId || '',
          times: 1,
          createdAt: now,
          updatedAt: now,
        };

    this.contacts.set(record.id, record);
    this.persist();
    logger.info(`Saved user contact: ${record.email} (${record.times}x, ${record.plan})`);
    return record;
  }

  async listContacts(limit: number = 200): Promise<ContactRecord[]> {
    return Array.from(this.contacts.values())
      .sort(
        (a, b) =>
          new Date(b.updatedAt || b.createdAt).getTime() -
          new Date(a.updatedAt || a.createdAt).getTime()
      )
      .slice(0, limit);
  }
}

function isTerminal(status: JobRecord['status']): boolean {
  return status === 'completed' || status === 'failed';
}

let dbInstance: DatabaseProvider | null = null;

export function getDatabase(): DatabaseProvider {
  if (!dbInstance) {
    dbInstance = new JsonFileDatabaseProvider();
    // Hosts that stop the process with SIGTERM get one last chance to upload the
    // newest job state before the next cold start recovers it from remote storage.
    process.once('SIGTERM', () => {
      void dbInstance!.flushRemote().finally(() => process.exit(0));
    });
  }
  return dbInstance;
}
