import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOriginPolicy} from './cors_policy.js';
test('development accepts Flutter random loopback ports only when enabled',()=>{
 const policy=createOriginPolicy('https://petie.example',true);
 for(const origin of ['http://localhost:49961','http://127.0.0.1:53210','https://petie.example']) assert.equal(policy(origin),true);
 for(const origin of ['http://localhost.evil.example:49961','http://evil.example','null','http://localhost:49961/path','http://user:password@localhost:49961']) assert.equal(policy(origin),false);
});
test('production requires exact configured origins; native requests have no Origin',()=>{
 const policy=createOriginPolicy(' https://petie.example , http://localhost:5173 ');
 assert.equal(policy('http://localhost:49961'),false);
 assert.equal(policy('http://localhost:5173'),true);
 assert.equal(policy(undefined),true);
});
