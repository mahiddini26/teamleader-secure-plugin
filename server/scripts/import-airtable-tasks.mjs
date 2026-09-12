import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { connect } from './connector-client.mjs';

// All remote operations go through the same authenticated MCP connector.
// Preview by default. Apply requires a resolved, reviewed plan and explicit flag.
const [planPath,journalPath,mode]=process.argv.slice(2);
if (!planPath || !journalPath) throw new Error('Usage: import-airtable-tasks.mjs plan.json journal.json [--apply]');
const plan=JSON.parse(readFileSync(planPath,'utf8'));
if(plan.total!==plan.tasks.length) throw new Error('Incomplete plan');
const apply=mode==='--apply';
if(mode && !apply) throw new Error('Unknown mode');
const errors=plan.tasks.flatMap(t=>[
  ...(!t.source_url || !t.source_id || !t.title || !t.description ? [`${t.source_id}: incomplete source`] : []),
  ...(!t.due_on || !t.work_type_id || !t.assignee_id ? [`${t.source_id}: unresolved task fields`] : []),
  ...(t.existing_legacy_id && !t.existing_task_id ? [`${t.source_id}: existing task UUID unresolved`] : []),
  ...(t.blockers || []).map(b=>`${t.source_id}: ${b}`),
]);
if(!apply) {console.log(JSON.stringify({mode:'preview_only',total:plan.total,ready:errors.length===0,blockers:errors},null,2));process.exit(0);}
if(errors.length) throw new Error(`Import blocked: ${errors.slice(0,10).join('; ')}`);
const lock=journalPath+'.lock';
const fd=openSync(lock,'wx');
const journal=existsSync(journalPath)?JSON.parse(readFileSync(journalPath,'utf8')):{records:{}};
const save=()=>writeFileSync(journalPath,JSON.stringify(journal,null,2)+'\n');
let client;
try {
  const connection=await connect();client=connection.client;const {call}=connection;
  for(const task of plan.tasks) {
    const saved=journal.records[task.source_id];
    if(saved?.source_hash && saved.source_hash!==task.source_hash) throw new Error(`Source changed since the previous run: ${task.source_id}`);
    // The source URL is stable even if the task title or due date was edited.
    const found=await call('list_tasks',{term:task.source_id,page:{number:1,size:20}});
    const matches=(found.data || []).filter(t=>(t.description || '').includes(task.source_url));
    if(matches.length>1 || (found.data || []).length===20) throw new Error(`Ambiguous source mapping: ${task.source_id}`);
    let id=saved?.task_id || task.existing_task_id || matches[0]?.id;
    if(saved?.state==='creating' && !id) throw new Error(`Previous creation result uncertain: ${task.source_id}. Reconcile before retry.`);
    if(id) {
      const current=(await call('get_task',{id})).data;
      if(current.id!==id) throw new Error('Task identity mismatch');
      if(id!==task.existing_task_id && !(current.description || '').includes(task.source_url)) throw new Error('Existing task source mismatch');
      if(!(current.description || '').includes(task.source_url)) {
        const description=[current.description,task.description].filter(Boolean).join('\n\n--- Import Airtable ---\n\n');
        const result=await call('update_task',{id,description,confirmed:true});
        if(!result.ok) throw new Error('Existing task update verification failed');
      }
      if(saved?.state==='verified') continue;
    } else {
      journal.records[task.source_id]={state:'creating',source_hash:task.source_hash};save();
      const created=await call('create_task',{title:task.title,description:task.description,due_on:task.due_on,work_type_id:task.work_type_id,assignee_type:'user',assignee_id:task.assignee_id,...(task.customer_type&&task.customer_id?{customer_type:task.customer_type,customer_id:task.customer_id}:{}),...(task.ticket_id?{ticket_id:task.ticket_id}:{}),confirmed:true});
      id=created.id;if(!id) throw new Error('Creation returned no task ID');
      journal.records[task.source_id]={state:'created',task_id:id,source_hash:task.source_hash};save();
    }
    if(task.completed) {
      const completed=await call('complete_task',{id,confirmed:true});
      if(!completed.ok) throw new Error('Completion verification failed');
    }
    const verified=(await call('get_task',{id})).data;
    if(verified.id!==id || !(verified.description || '').includes(task.source_url) || (task.completed && !verified.completed)) throw new Error(`Read-back verification failed: ${task.source_id}`);
    if(!task.existing_task_id && (verified.title!==task.title || verified.due_on!==task.due_on || verified.assignee?.id!==task.assignee_id)) throw new Error(`Created task fields differ: ${task.source_id}`);
    journal.records[task.source_id]={state:'verified',task_id:id,source_hash:task.source_hash,verified_at:new Date().toISOString(),attachments:task.attachment_status};save();
    console.log(JSON.stringify({source_id:task.source_id,task_id:id,state:'verified'}));
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
} finally {if(client) await client.close();closeSync(fd);unlinkSync(lock);}
