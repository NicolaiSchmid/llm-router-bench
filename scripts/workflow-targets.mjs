import { readFileSync, appendFileSync } from 'node:fs';
const profiles=JSON.parse(readFileSync('providers/index.json','utf8'));
const manual=process.env.EVENT==='workflow_dispatch';
const weekly=process.env.SCHEDULE==='17 5 * * 0';
const raw=manual?[{provider:process.env.INPUT_PROVIDER,model:process.env.INPUT_MODEL,protocol:process.env.INPUT_PROTOCOL}]:JSON.parse(readFileSync('schedules/targets.json','utf8'));
if(!Array.isArray(raw)||raw.length>20)throw new Error('Invalid target panel');
const include=raw.map(t=>{
 const p=profiles.find(p=>p.id===t.provider);
 if(!p||typeof t.model!=='string'||!t.model.length||t.model.length>200||/\s/.test(t.model)||!p.protocols.includes(t.protocol))throw new Error('Invalid target');
 const repetitions=manual?Number(process.env.INPUT_REPETITIONS):1;
 const maxRequests=manual?Number(process.env.INPUT_MAX_REQUESTS):weekly?300:100;
 if(!Number.isSafeInteger(repetitions)||repetitions<1||repetitions>1000||!Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>10000)throw new Error('Invalid run limits');
 return {...t,suite:weekly&&t.protocol!=='messages'?'legacy':'core',repetitions,maxRequests};
});
appendFileSync(process.env.GITHUB_OUTPUT,`matrix=${JSON.stringify({include})}\nany=${include.length>0}\n`);
