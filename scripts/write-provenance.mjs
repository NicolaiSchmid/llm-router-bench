import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const suiteCommit=execFileSync('git',['rev-parse','HEAD']).toString().trim();
const lockfileSha256=createHash('sha256').update(readFileSync('package-lock.json')).digest('hex');
writeFileSync('dist/provenance.json',JSON.stringify({suiteCommit,lockfileSha256},null,2)+'\n');
