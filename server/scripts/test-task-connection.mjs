import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { connect } from './connector-client.mjs';

const output=process.argv[2];
if (!output) throw new Error('Pass the report filename. This live check creates and removes only its own clearly labelled test task.');
const report={started_at:new Date().toISOString(),tests:[],task_id:null,event_id:null,ok:false};
const save=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n');
const {client,call}=await connect();
const check=async (name,args={},verify=()=>{})=>{
  const r=await call(name,args); verify(r);
  if(r.ok===false) throw new Error(`${name}: read-back verification failed`);
  report.tests.push({tool:name,passed:true});save();return r;
};
let failure;
try {
  const tools=await client.listTools();
  const required=['get_task','list_tasks','create_task','update_task','complete_task','reopen_task','delete_task','schedule_task','list_task_events','reschedule_task_event','cancel_task_event'];
  for(const name of required) assert(tools.tools.some(t=>t.name===name),`Missing ${name}`);
  report.discovered_task_tools=required;
  const me=(await check('get_current_user')).data;
  const work=(await check('list_work_types',{page:{number:1,size:20}})).data;
  const type=work.find(w=>/administration/i.test(w.name)) || work[0];
  assert(me?.id && type?.id,'Missing user or work type');
  await check('list_tasks',{page:{number:1,size:20}});
  const marker=`CODEX-API-TEST-${Date.now()}`;
  const title=`[TEST CONNECTEUR CODEX] ${marker}`;
  const created=await check('create_task',{title,description:`Test technique temporaire du connecteur. ${marker}`,due_on:'2026-09-14',work_type_id:type.id,assignee_type:'user',assignee_id:me.id,confirmed:true});
  report.task_id=created.id;save();assert(created.id);
  const task=await check('get_task',{id:created.id});
  assert.equal(task.data.title,title);assert.equal(task.data.due_on,'2026-09-14');
  await check('update_task',{id:created.id,description:`Test lecture et écriture vérifié. ${marker}`,confirmed:true});
  await check('complete_task',{id:created.id,confirmed:true});
  await check('reopen_task',{id:created.id,confirmed:true});
  const event=await check('schedule_task',{id:created.id,starts_at:'2026-09-14T18:00:00+02:00',ends_at:'2026-09-14T18:05:00+02:00',confirmed:true});
  report.event_id=event.event.id;save();
  await check('list_task_events',{id:created.id,page:{number:1,size:20}});
  await check('reschedule_task_event',{id:created.id,event_id:report.event_id,starts_at:'2026-09-14T18:05:00+02:00',ends_at:'2026-09-14T18:10:00+02:00',confirmed:true});
} catch(error) {failure=error;report.error=error.message;save();}
finally {
  try {
    if(report.event_id) {await check('cancel_task_event',{id:report.task_id,event_id:report.event_id,confirmed:true});report.event_removed=true;save();}
    if(report.task_id) {await check('delete_task',{id:report.task_id,confirmed:true});report.task_removed=true;save();}
  } catch(error) {report.cleanup_error=error.message;failure ||= error;}
  await client.close();
  report.ok=!failure;report.finished_at=new Date().toISOString();save();
}
console.log(JSON.stringify(report));
if(failure) process.exitCode=1;
