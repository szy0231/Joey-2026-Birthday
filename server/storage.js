// Object storage over the S3 API.
//   makeStorage  Cloudflare R2: the durable home of every original, cover, record and playable copy.
//   makeMirror   optional Tencent Cloud COS bucket in mainland China holding only the playable copies, so a
//                viewer in mainland China can download them fast. Its default domain needs no ICP filing.
// Either one is disabled when its variables are missing.
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { S3Client, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export function makeStorage(env) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return { enabled: false };
  return bucketStore({
    name: 'Cloudflare R2', bucket: R2_BUCKET, region: 'auto', pathStyle: true,
    endpoint: env.R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY,
  });
}

export function makeMirror(env) {
  const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION } = env;
  if (!COS_SECRET_ID || !COS_SECRET_KEY || !COS_BUCKET || !COS_REGION) return { enabled: false };
  return bucketStore({
    name: '腾讯云 COS', bucket: COS_BUCKET, region: COS_REGION, pathStyle: !!env.COS_ENDPOINT,
    endpoint: env.COS_ENDPOINT || `https://cos.${COS_REGION}.myqcloud.com`,
    accessKeyId: COS_SECRET_ID, secretAccessKey: COS_SECRET_KEY,
  });
}

function bucketStore({ name, bucket, region, endpoint, pathStyle, accessKeyId, secretAccessKey }) {
  const s3 = new S3Client({
    region, endpoint, forcePathStyle: pathStyle,
    // Neither R2 nor COS needs the SDK's newer default checksums; only send them when an operation requires one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId, secretAccessKey },
  });
  return {
    enabled: true,
    name,
    bucket,
    // Multipart upload streamed from disk, so a 4 GB file never sits in memory.
    async putFile(key, file, contentType) {
      await new Upload({
        client: s3, queueSize: 2, partSize: 16 * 1024 ** 2,
        params: { Bucket: bucket, Key: key, Body: fs.createReadStream(file), ContentType: contentType },
      }).done();
    },
    async putBuffer(key, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    // A time-limited link a browser can download straight from the bucket, without the bucket being public.
    presign(key, seconds) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: seconds });
    },
    async putJSON(key, obj) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(obj, null, 2), ContentType: 'application/json; charset=utf-8' }));
    },
    // Download to `file` (written to a temporary name first, so a half download is never mistaken for the file).
    async getFile(key, file) {
      const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      await pipeline(r.Body, fs.createWriteStream(file + '.part'));
      await fs.promises.rename(file + '.part', file);
    },
    // Every key that starts with `prefix`.
    async list(prefix) {
      const keys = []; let token;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents || []) keys.push(o.Key);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async size(key) {
      return (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentLength;
    },
  };
}
