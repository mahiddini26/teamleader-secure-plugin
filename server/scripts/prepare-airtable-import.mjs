import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function prepare(source, firstFive) {
  if (source.nextCursor || source.records.length !== source.metadata?.totalRecordCount) throw new Error('Incomplete Airtable inventory');
  const seen = new Set();
  const tasks = source.records.map(record => {
    if (seen.has(record.id)) throw new Error('Duplicate Airtable record ID');
    seen.add(record.id);
    const f=record.cellValuesByFieldId;
    const existing=firstFive.tasks.find(t=>t.airtable===record.id);
    const sourceUrl=`https://airtable.com/apprVqTeVwWd8oGaY/tblEBLVL2OD05pKty/${record.id}`;
    const status=f.fld5FTuEKuBR2l55H?.name || 'Non renseigné';
    const due=existing?.due || f.fldkbol6TY2TsRHuM || null;
    const parts=[['Source Airtable',sourceUrl],['Statut source',status],['Client / entité',record.id==='recXygWDQYC1L48Jc'?'SITBON GILLES (confirmé par Michael)':f.fld7B5LLSuEth3Kbe],['Priorité source',f.fldYQZCxwergtAQE6?.name],['Résumé actuel',f.fldCkLriPFrRyWLyp],['Dernière action',f.fldbfbfJLOGyjrP4g],['Date dernière action',f.fldhNQygzQYyIYPqH],['En attente de',f.fld29Dld5aZoaOitW],['Prochaine action',f.fld4RKd3PII2iHszx],['Informations manquantes',f.fldytA958WLglBP0A],['Conversation',f.fldtzp3IyyxGDb59q],['Teamleader source',f.fldNdk4jN6EhEU2IZ],['Dropbox source',f.fldDA7cEfHqFfvpD7],['Risque de couverture',f.fldLEWQJ9OWg6hXjT?'Signalé dans Airtable':null]];
    const description=parts.filter(([,value])=>value).map(([label,value])=>`${label} :\n${value}`).join('\n\n');
    if (description.length>50000) throw new Error(`Description too long: ${record.id}`);
    return {source_id:record.id,source_url:sourceUrl,source_hash:createHash('sha256').update(JSON.stringify(f)).digest('hex'),title:existing?.title || f.flduAUZVbEgXZyx0v,description,due_on:due,completed:status==='Terminé',assignee_hint:status==='À traiter par Sofia'?'Sofia Hasnaoui':'Michael',existing_legacy_id:existing?.teamleader || null,action:existing?'reconcile_existing':'create_after_validation',attachment_status:'conversation_files_to_inventory',blockers:[...(!due?['missing_due_date']:[]),'resolve_teamleader_references','verify_conversation_attachments']};
  });
  return {schema_version:1,mode:'preview_only',base:'apprVqTeVwWd8oGaY',table:'tblEBLVL2OD05pKty',total:tasks.length,completed:tasks.filter(t=>t.completed).length,already_created:tasks.filter(t=>t.existing_legacy_id).length,missing_due_date:tasks.filter(t=>!t.due_on).length,tasks};
}
if (process.argv[1]?.endsWith('/prepare-airtable-import.mjs')) {
  const [, ,sourcePath,firstFivePath,outputPath]=process.argv;
  const plan=prepare(JSON.parse(readFileSync(sourcePath,'utf8')),JSON.parse(readFileSync(firstFivePath,'utf8')));
  writeFileSync(outputPath,JSON.stringify(plan,null,2)+'\n');
  console.log(JSON.stringify({total:plan.total,completed:plan.completed,already_created:plan.already_created,missing_due_date:plan.missing_due_date,mode:plan.mode}));
}
