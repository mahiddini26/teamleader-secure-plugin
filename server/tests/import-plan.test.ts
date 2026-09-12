import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore Standalone local migration helper.
import { prepare } from '../scripts/prepare-airtable-import.mjs';

test('import plan preserves completed status and reconciles existing tasks',()=>{
  const r={id:'rec1',cellValuesByFieldId:{flduAUZVbEgXZyx0v:'Task',fld5FTuEKuBR2l55H:{name:'Terminé'}}};
  const plan=prepare({metadata:{totalRecordCount:1},records:[r]},{tasks:[{airtable:'rec1',teamleader:'54864695',title:'Task',due:'2026-09-14'}]});
  assert.equal(plan.tasks[0].action,'reconcile_existing');
  assert.equal(plan.tasks[0].completed,true);
  assert.equal(plan.tasks[0].due_on,'2026-09-14');
  assert(plan.tasks[0].description.includes('/rec1'));
});
test('import plan stops on partial inventory and keeps unknown dates unresolved',()=>{
  assert.throws(()=>prepare({metadata:{totalRecordCount:2},records:[]},{tasks:[]}),/Incomplete/);
  const plan=prepare({metadata:{totalRecordCount:1},records:[{id:'rec1',cellValuesByFieldId:{flduAUZVbEgXZyx0v:'Task'}}]},{tasks:[]});
  assert.equal(plan.tasks[0].due_on,null);
  assert(plan.tasks[0].blockers.includes('missing_due_date'));
});
