// Cloudflare R2 (S3-compatible). If the R2_* variables are missing, storage is disabled and files stay on local disk.
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export function makeStorage(env) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return { enabled: false };

  const s3 = new S3Client({
    region: 'auto',
    forcePathStyle: true,
    // R2 does not need the SDK's newer default checksums; only send them when an operation requires one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    endpoint: env.R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return {
    enabled: true,
    bucket: R2_BUCKET,
    // Multipart upload streamed from disk, so a 4 GB file never sits in memory.
    async putFile(key, file, contentType) {
      await new Upload({
        client: s3, queueSize: 2, partSize: 16 * 1024 ** 2,
        params: { Bucket: R2_BUCKET, Key: key, Body: fs.createReadStream(file), ContentType: contentType },
      }).done();
    },
    async putJSON(key, obj) {
      await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: JSON.stringify(obj, null, 2), ContentType: 'application/json; charset=utf-8' }));
    },
    // Download to `file` (written to a temporary name first, so a half download is never mistaken for the file).
    async getFile(key, file) {
      const r = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
      await pipeline(r.Body, fs.createWriteStream(file + '.part'));
      await fs.promises.rename(file + '.part', file);
    },
    async size(key) {
      return (await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }))).ContentLength;
    },
  };
}
