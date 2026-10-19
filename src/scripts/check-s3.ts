import 'dotenv/config';
import {HeadBucketCommand,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,S3Client} from '@aws-sdk/client-s3';
import {randomUUID} from 'node:crypto';
import {getS3Client,getS3Config} from '../services/s3.service.js';
let client:S3Client|undefined;
let testKey:string|undefined;
let bucket:string|undefined;
try {
  const config=getS3Config();bucket=config.bucket;client=getS3Client();
  await client.send(new HeadBucketCommand({Bucket:bucket}));
  console.log('S3 connection: OK');
  if(process.argv.includes('--write')) {
    testKey=`uploads/connection-check-${randomUUID()}.txt`;
    const content='Petie S3 connection check';
    await client.send(new PutObjectCommand({Bucket:bucket,Key:testKey,Body:content,ContentType:'text/plain'}));
    const result=await client.send(new GetObjectCommand({Bucket:bucket,Key:testKey}));
    if(await result.Body?.transformToString()!==content)throw new Error('ReadBackMismatch');
    console.log('S3 upload and download: OK');
  }
} catch(error) {
  console.error('S3 connection failed:', error instanceof Error ? error.name : 'UnknownError');
  console.error('Check AWS_REGION, AWS_S3_BUCKET_NAME and IAM permissions.');
  process.exitCode=1;
} finally {
  if(client&&bucket&&testKey){try{await client.send(new DeleteObjectCommand({Bucket:bucket,Key:testKey}));console.log('Temporary check object removed');}catch{console.error('Could not delete temporary check object:',testKey);process.exitCode=1;}}
  client?.destroy();
}
