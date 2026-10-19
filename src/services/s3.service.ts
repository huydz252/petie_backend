import 'dotenv/config';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

export interface ImageFile { buffer: Buffer; mimetype: string; originalname?: string }
export function getS3Config() {
  const region = process.env.AWS_REGION?.trim();
  const bucket = process.env.AWS_S3_BUCKET_NAME?.trim();
  if (!region || !bucket) throw new Error('Cần cấu hình AWS_REGION và AWS_S3_BUCKET_NAME trong .env');
  return { region, bucket };
}
let client: S3Client | undefined;
export function getS3Client(): S3Client {
  return client ??= new S3Client({ region: getS3Config().region, maxAttempts: 3 });
}
export function imageExtension(bytes: Buffer): 'jpg' | 'png' | 'webp' {
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('Ảnh phải nhỏ hơn hoặc bằng 4 MB');
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'webp';
  throw new Error('Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP');
}
export function validImageName(name: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/.test(name);
}
export async function uploadFileToS3(file: ImageFile): Promise<string> {
  const extension = imageExtension(file.buffer);
  const name = `${randomUUID()}.${extension}`;
  const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, '');
  if (!publicUrl) throw new Error('Cần cấu hình PUBLIC_URL để hiển thị ảnh trên ứng dụng');
  const type = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
  await getS3Client().send(new PutObjectCommand({
    Bucket: getS3Config().bucket, Key: `uploads/${name}`, Body: file.buffer,
    ContentType: type, CacheControl: 'public, max-age=86400, immutable',
  }));
  // Stable application URL works even when S3 blocks public access.
  return `${publicUrl}/api/v1/media/s3/${name}`;
}
export async function readImageFromS3(name: string) {
  if (!validImageName(name)) throw new Error('Invalid image name');
  const result = await getS3Client().send(new GetObjectCommand({Bucket: getS3Config().bucket, Key: `uploads/${name}`}));
  if (!result.Body) throw new Error('S3 returned an empty response');
  return { bytes: Buffer.from(await result.Body.transformToByteArray()), contentType: result.ContentType ?? 'application/octet-stream' };
}
