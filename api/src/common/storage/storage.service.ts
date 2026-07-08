import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { dirname, join, normalize } from 'path';

/**
 * Storage seam (Invariant 11, 08 §8). Every module that persists blobs (site-map images) uses this
 * service; the real integration is a later env flip, not a rebuild. Two drivers:
 *  - LocalDiskDriver (STORAGE_MODE=local, default): writes UPLOADS_DIR/<key>, served read-only at
 *    GET /files/*; signedGetUrl → '/api/files/<key>' (the browser reaches the API through the Next
 *    proxy which strips '/api' — the API itself serves '/files/*', see main.ts).
 *  - S3Driver (STORAGE_MODE=s3): the existing stub kept for the later S3 flip.
 */
export interface StorageDriver {
  putObject(key: string, body: Buffer, contentType: string): Promise<{ key: string }>;
  signedGetUrl(key: string): string;
}

/** Reject keys that could escape UPLOADS_DIR. Keys are app-generated, but guard anyway. */
function assertSafeKey(key: string): void {
  if (!key || key.includes('..') || key.startsWith('/') || key.includes('\0'))
    throw new Error(`unsafe storage key: ${key}`);
}

/** Local-disk driver — the offline default (08 §8). Writes under UPLOADS_DIR, mkdir -p parents. */
export class LocalDiskDriver implements StorageDriver {
  private readonly logger = new Logger('Storage:local');
  private get root(): string {
    return process.env.UPLOADS_DIR ?? './uploads';
  }

  async putObject(key: string, body: Buffer, _contentType: string): Promise<{ key: string }> {
    assertSafeKey(key);
    const full = join(this.root, normalize(key));
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, body);
    this.logger.log(`wrote ${key} (${body.length} bytes)`);
    return { key };
  }

  /** Relative '/api/...' — the Next proxy strips '/api' and the API serves '/files/*'. */
  signedGetUrl(key: string): string {
    assertSafeKey(key);
    return `/api/files/${key}`;
  }
}

/** S3 stub — kept from the v1 no-op for the STORAGE_MODE=s3 flip (real SDK wires in later). */
export class S3Driver implements StorageDriver {
  private readonly endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
  private readonly bucket = process.env.S3_BUCKET ?? 'gemplots-dev';

  async putObject(key: string, _body: Buffer, _contentType: string): Promise<{ key: string }> {
    // TODO(s3): real S3 PUT via @aws-sdk/client-s3 against S3_ENDPOINT.
    return { key };
  }

  signedGetUrl(key: string): string {
    return `${this.endpoint}/${this.bucket}/${key}`;
  }
}

@Injectable()
export class StorageService implements StorageDriver {
  private readonly local = new LocalDiskDriver();
  private readonly s3 = new S3Driver();

  /** Driver chosen at call time (no caching) so tests can flip STORAGE_MODE around a call. */
  private driver(): StorageDriver {
    return (process.env.STORAGE_MODE ?? 'local') === 's3' ? this.s3 : this.local;
  }

  putObject(key: string, body: Buffer, contentType: string) {
    return this.driver().putObject(key, body, contentType);
  }

  signedGetUrl(key: string): string {
    return this.driver().signedGetUrl(key);
  }
}
