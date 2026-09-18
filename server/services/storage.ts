import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { logger } from '../utils/logger.js';

export interface StorageInfo {
  provider: string;
  configured: boolean;
  bucket?: string;
  endpoint?: string;
  hasCredentials?: boolean;
  message?: string;
}

export interface StorageProvider {
  name: string;
  isConfigured(): boolean;
  getInfo(): StorageInfo;
  saveFile(category: 'uploads' | 'processing' | 'outputs', filename: string, bufferOrPath: Buffer | string): Promise<string>;
  getFilePath(category: 'uploads' | 'processing' | 'outputs', filename: string): string;
  ensureFileAvailable(category: 'uploads' | 'processing' | 'outputs', filename: string): Promise<string | null>;
  getFileStream(category: 'uploads' | 'processing' | 'outputs', filename: string): Promise<Readable>;
  deleteFile(category: 'uploads' | 'processing' | 'outputs', filename: string): Promise<void>;
  cleanProcessingDir(jobId: string): Promise<void>;
}

export interface S3ParsedConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  isR2: boolean;
  hasCredentials: boolean;
}

/**
 * Parse and normalize S3/Cloudflare R2 configuration
 * Supports URL formats like https://c838eceff526b328e8385736a138fb6b.r2.cloudflarestorage.com/061
 * and separate S3_ENDPOINT + S3_BUCKET variables.
 */
export function parseS3Config(): S3ParsedConfig {
  let rawEndpoint =
    process.env.S3_ENDPOINT ||
    process.env.R2_ENDPOINT ||
    'https://c838eceff526b328e8385736a138fb6b.r2.cloudflarestorage.com';

  let bucket = process.env.S3_BUCKET || process.env.R2_BUCKET || '';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '';
  const region = process.env.S3_REGION || process.env.R2_REGION || 'auto';

  let endpoint = rawEndpoint.trim();

  // If endpoint is a full URL, extract path segment if bucket not set
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    try {
      const parsedUrl = new URL(endpoint);
      const pathSegments = parsedUrl.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
      if (pathSegments.length > 0 && !bucket) {
        bucket = pathSegments[0]; // e.g., '061'
      }
      // Clean endpoint to origin only for AWS S3Client compatibility
      endpoint = parsedUrl.origin;
    } catch (e) {
      logger.warn('Failed to parse S3_ENDPOINT URL:', e);
    }
  }

  // Default to 061 for Cloudflare R2 account c838eceff526b328e8385736a138fb6b if unspecified
  if (!bucket && endpoint.includes('c838eceff526b328e8385736a138fb6b')) {
    bucket = '061';
  }

  const isR2 = endpoint.includes('.r2.cloudflarestorage.com');
  const hasCredentials = Boolean(accessKeyId.trim() && secretAccessKey.trim());

  return {
    endpoint,
    bucket: bucket || '061',
    region,
    accessKeyId: accessKeyId.trim(),
    secretAccessKey: secretAccessKey.trim(),
    isR2,
    hasCredentials,
  };
}

export class LocalStorageProvider implements StorageProvider {
  name = 'local';
  private baseDir: string;

  constructor(baseDir: string = path.join(process.cwd(), 'data')) {
    this.baseDir = baseDir;
    this.ensureDirs();
  }

  private ensureDirs() {
    ['uploads', 'processing', 'outputs'].forEach((sub) => {
      const dir = path.join(this.baseDir, sub);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  isConfigured(): boolean {
    return true;
  }

  getInfo(): StorageInfo {
    return {
      provider: 'Local Storage (High-Speed Local Buffer)',
      configured: true,
      hasCredentials: true,
      message: 'Local disk buffer active at data/',
    };
  }

  getFilePath(category: 'uploads' | 'processing' | 'outputs', filename: string): string {
    return path.join(this.baseDir, category, filename);
  }

  async ensureFileAvailable(category: 'uploads' | 'processing' | 'outputs', filename: string): Promise<string | null> {
    const target = this.getFilePath(category, filename);
    return fs.existsSync(target) ? target : null;
  }

  async saveFile(category: 'uploads' | 'processing' | 'outputs', filename: string, bufferOrPath: Buffer | string): Promise<string> {
    const target = this.getFilePath(category, filename);
    const parent = path.dirname(target);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }

    if (typeof bufferOrPath === 'string') {
      if (bufferOrPath !== target) {
        fs.copyFileSync(bufferOrPath, target);
      }
    } else {
      fs.writeFileSync(target, bufferOrPath);
    }
    return target;
  }

  async getFileStream(category: 'uploads' | 'processing' | 'outputs', filename: string): Promise<Readable> {
    const target = this.getFilePath(category, filename);
    if (!fs.existsSync(target)) {
      throw new Error(`File not found: ${target}`);
    }
    return fs.createReadStream(target);
  }

  async deleteFile(category: 'uploads' | 'processing' | 'outputs', filename: string): Promise<void> {
    const target = this.getFilePath(category, filename);
    if (fs.existsSync(target)) {
      try {
        fs.unlinkSync(target);
      } catch (err) {
        logger.warn(`Failed to delete local file ${target}:`, err);
      }
    }
  }

  async cleanProcessingDir(jobId: string): Promise<void> {
    const procDir = path.join(this.baseDir, 'processing', jobId);
    if (fs.existsSync(procDir)) {
      try {
        fs.rmSync(procDir, { recursive: true, force: true });
        logger.info(`Cleaned processing artifacts for job ${jobId}`);
      } catch (err) {
        logger.warn(`Failed to clean processing dir for job ${jobId}:`, err);
      }
    }
  }
}

export class S3StorageProvider implements StorageProvider {
  name = 's3';
  private s3: S3Client | null = null;
  private config: S3ParsedConfig;
  private localFallback: LocalStorageProvider;
  private connectionTested = false;
  private connectionError: string | null = null;

  constructor() {
    this.localFallback = new LocalStorageProvider();
    this.config = parseS3Config();

    if (this.config.hasCredentials) {
      try {
        this.s3 = new S3Client({
          region: this.config.region || 'auto',
          endpoint: this.config.endpoint,
          credentials: {
            accessKeyId: this.config.accessKeyId,
            secretAccessKey: this.config.secretAccessKey,
          },
          // Critical for Cloudflare R2 and non-AWS S3 endpoints:
          forcePathStyle: true,
        });
        logger.info(
          `S3 Storage Provider initialized for bucket: ${this.config.bucket} at ${this.config.endpoint}`
        );
        this.testConnection();
      } catch (err: any) {
        this.connectionError = err?.message || 'Failed to initialize S3Client';
        logger.error('Error initializing S3Client:', err);
      }
    } else {
      logger.info(
        `Cloudflare R2 target configured (${this.config.endpoint}/${this.config.bucket}). S3 credentials pending in environment.`
      );
    }
  }

  private async testConnection(): Promise<void> {
    if (!this.s3 || !this.config.bucket) return;
    try {
      await this.s3.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        MaxKeys: 1,
      }));
      this.connectionTested = true;
      this.connectionError = null;
      logger.info(`Successfully verified connection to S3/R2 bucket: ${this.config.bucket}`);
    } catch (err: any) {
      this.connectionTested = false;
      this.connectionError = err?.message || 'Connection test failed';
      logger.warn(`S3/R2 connection verification note for bucket ${this.config.bucket}: ${this.connectionError}`);
    }
  }

  isConfigured(): boolean {
    return Boolean(this.config.hasCredentials && this.s3 && this.config.bucket);
  }

  getInfo(): StorageInfo {
    const isCloudflare = this.config.isR2;
    const providerName = isCloudflare ? 'Cloudflare R2 Storage (S3 API)' : 'S3 Object Storage';

    if (this.isConfigured()) {
      return {
        provider: providerName,
        configured: true,
        bucket: this.config.bucket,
        endpoint: this.config.endpoint,
        hasCredentials: true,
        message: this.connectionError
          ? `Connected to ${this.config.bucket} (${this.connectionError})`
          : `Connected to bucket "${this.config.bucket}" at ${this.config.endpoint}`,
      };
    }

    return {
      provider: providerName,
      configured: false,
      bucket: this.config.bucket,
      endpoint: this.config.endpoint,
      hasCredentials: false,
      message: `R2 Target: ${this.config.endpoint}/${this.config.bucket}. Waiting for S3_ACCESS_KEY_ID & S3_SECRET_ACCESS_KEY.`,
    };
  }

  getFilePath(category: 'uploads' | 'processing' | 'outputs', filename: string): string {
    return this.localFallback.getFilePath(category, filename);
  }

  async ensureFileAvailable(category: 'uploads' | 'processing' | 'outputs', filename: string): Promise<string | null> {
    const localTarget = this.localFallback.getFilePath(category, filename);
    if (fs.existsSync(localTarget)) {
      return localTarget;
    }

    // Try downloading from S3/R2 if configured
    if (this.s3 && this.config.bucket) {
      try {
        const key = `${category}/${filename}`;
        const res = await this.s3.send(new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        }));

        const parent = path.dirname(localTarget);
        if (!fs.existsSync(parent)) {
          fs.mkdirSync(parent, { recursive: true });
        }

        const bodyStream = res.Body as Readable;
        const writeStream = fs.createWriteStream(localTarget);

        await new Promise<void>((resolve, reject) => {
          bodyStream.pipe(writeStream);
          writeStream.on('finish', () => resolve());
          writeStream.on('error', (err) => reject(err));
        });

        logger.info(`Fetched and cached ${key} from Cloudflare R2 bucket ${this.config.bucket}`);
        return localTarget;
      } catch (err) {
        logger.warn(`File ${filename} not found in S3/R2 or failed to retrieve:`, err);
      }
    }

    return null;
  }

  async saveFile(category: 'uploads' | 'processing' | 'outputs', filename: string, bufferOrPath: Buffer | string): Promise<string> {
    // Always persist to local high-speed cache first
    const localPath = await this.localFallback.saveFile(category, filename, bufferOrPath);

    // Sync upload to S3/Cloudflare R2 if configured and it's a permanent artifact (uploads or outputs)
    if (this.s3 && this.config.bucket && (category === 'uploads' || category === 'outputs')) {
      try {
        const fileBuffer = typeof bufferOrPath === 'string' ? fs.readFileSync(bufferOrPath) : bufferOrPath;
        const key = `${category}/${filename}`;

        const ext = path.extname(filename).toLowerCase();
        const contentTypes: Record<string, string> = {
          '.mp4': 'video/mp4',
          '.webm': 'video/webm',
          '.mov': 'video/quicktime',
          '.mp3': 'audio/mpeg',
          '.wav': 'audio/wav',
          '.vtt': 'text/vtt; charset=utf-8',
          '.srt': 'text/plain; charset=utf-8',
          '.json': 'application/json',
        };
        const contentType = contentTypes[ext] || 'application/octet-stream';

        await this.s3.send(new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: fileBuffer,
          ContentType: contentType,
        }));
        logger.info(`Uploaded ${key} (${fileBuffer.length} bytes) to Cloudflare R2 bucket ${this.config.bucket}`);
      } catch (err) {
        logger.warn(`Failed to upload to S3/R2 (${category}/${filename}), local cached copy is preserved:`, err);
      }
    }

    return localPath;
  }

  async getFileStream(category: 'uploads' | 'processing' | 'outputs', filename: string): Promise<Readable> {
    const localTarget = this.localFallback.getFilePath(category, filename);
    if (fs.existsSync(localTarget)) {
      return fs.createReadStream(localTarget);
    }

    if (this.s3 && this.config.bucket) {
      const key = `${category}/${filename}`;
      const res = await this.s3.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }));
      return res.Body as Readable;
    }

    throw new Error(`File not found: ${category}/${filename}`);
  }

  async deleteFile(category: 'uploads' | 'processing' | 'outputs', filename: string): Promise<void> {
    await this.localFallback.deleteFile(category, filename);
    if (this.s3 && this.config.bucket) {
      try {
        await this.s3.send(new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: `${category}/${filename}`,
        }));
        logger.info(`Deleted ${category}/${filename} from Cloudflare R2 bucket ${this.config.bucket}`);
      } catch (e) {
        logger.warn(`Failed to delete S3/R2 object:`, e);
      }
    }
  }

  async cleanProcessingDir(jobId: string): Promise<void> {
    await this.localFallback.cleanProcessingDir(jobId);
  }
}

let storageInstance: StorageProvider | null = null;

export function getStorage(): StorageProvider {
  const s3Config = parseS3Config();

  // S3/R2 is optional replication on top of the local buffer. Only switch to the
  // cloud provider once real credentials exist, so the app works with zero config
  // and the system status reports local storage instead of "waiting for keys".
  if (!storageInstance) {
    storageInstance = s3Config.hasCredentials ? new S3StorageProvider() : new LocalStorageProvider();
  } else if (storageInstance.name === 'local' && s3Config.hasCredentials) {
    storageInstance = new S3StorageProvider();
  }
  return storageInstance;
}

