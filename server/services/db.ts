import fs from 'fs';
import path from 'path';
import { JobRecord, DialogueSegment } from '../types.js';
import { logger } from '../utils/logger.js';

export interface DatabaseProvider {
  createJob(job: JobRecord): Promise<JobRecord>;
  getJob(id: string): Promise<JobRecord | null>;
  updateJob(id: string, updates: Partial<JobRecord>): Promise<JobRecord | null>;
  listJobs(limit?: number): Promise<JobRecord[]>;
  deleteJob(id: string): Promise<boolean>;
  saveSegments(jobId: string, segments: DialogueSegment[]): Promise<void>;
  getSegments(jobId: string): Promise<DialogueSegment[]>;
}

export class JsonFileDatabaseProvider implements DatabaseProvider {
  private dbPath: string;
  private jobs: Map<string, JobRecord> = new Map();
  private segments: Map<string, DialogueSegment[]> = new Map();

  constructor(filePath: string = path.join(process.cwd(), 'data', 'db.json')) {
    this.dbPath = filePath;
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
        logger.info(`Loaded ${this.jobs.size} jobs from database store`);
      } catch (err) {
        logger.warn('Failed to parse database file, initializing empty store:', err);
      }
    }
  }

  private persist() {
    try {
      const payload = {
        jobs: Array.from(this.jobs.values()),
        segments: Object.fromEntries(this.segments.entries()),
      };
      fs.writeFileSync(this.dbPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to persist database store:', e);
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
}

let dbInstance: DatabaseProvider | null = null;

export function getDatabase(): DatabaseProvider {
  if (!dbInstance) {
    dbInstance = new JsonFileDatabaseProvider();
  }
  return dbInstance;
}
