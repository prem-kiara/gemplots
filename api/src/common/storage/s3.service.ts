import { Injectable } from '@nestjs/common';

/**
 * S3 client seam (slice 4 wires a real S3-compatible SDK). For dev/tests it stores nothing and
 * returns a deterministic signed-ish URL so the read APIs have something to serve.
 */
@Injectable()
export class S3Service {
  private readonly endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
  private readonly bucket = process.env.S3_BUCKET ?? 'gemplots-dev';

  async putObject(key: string, _body: Buffer, _contentType: string): Promise<{ key: string }> {
    // TODO(slice-4): real S3 PUT via @aws-sdk/client-s3 against S3_ENDPOINT.
    return { key };
  }

  /** A URL the client can GET. Real impl returns a presigned URL with expiry. */
  signedGetUrl(key: string): string {
    return `${this.endpoint}/${this.bucket}/${key}`;
  }
}
