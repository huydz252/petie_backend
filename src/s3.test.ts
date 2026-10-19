import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imageExtension,validImageName} from './services/s3.service.js';
test('image metadata comes from bytes rather than supplied extension',()=>{
 assert.equal(imageExtension(Buffer.from([255,216,255,0])),'jpg');
 assert.equal(imageExtension(Buffer.from([137,80,78,71,13,10,26,10])),'png');
 assert.throws(()=>imageExtension(Buffer.from('<script>alert(1)</script>')));
 assert.throws(()=>imageExtension(Buffer.alloc(4*1024*1024+1)));
});
test('S3 image retrieval cannot traverse to arbitrary keys',()=>{
 assert.equal(validImageName('12345678-1234-4123-8123-123456789abc.png'),true);
 for(const name of ['../secret','private.pdf','uploads/test.jpg','12345678-1234-4123-8123-123456789abc.svg']) assert.equal(validImageName(name),false);
});
