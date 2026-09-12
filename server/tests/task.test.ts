import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskCreatePayload, findTaskDuplicate, checkTaskDuplicate } from "../src/task.ts";

test("buildTaskCreatePayload matches Teamleader tasks.create", () => {
	assert.deepEqual(buildTaskCreatePayload({
		title: "Relancer le client",
		description: "Vérifier les pièces avant l'appel.",
		due_on: "2026-09-14",
		work_type_id: "work-type-id",
		estimated_duration_minutes: 30,
		assignee_type: "user",
		assignee_id: "user-id",
		customer_type: "company",
		customer_id: "company-id",
		deal_id: "deal-id",
		ticket_id: "ticket-id",
		project_id: "project-id",
	}), {
		title: "Relancer le client",
		description: "Vérifier les pièces avant l'appel.",
		due_on: "2026-09-14",
		work_type_id: "work-type-id",
		estimated_duration: { unit: "min", value: 30 },
		assignee: { type: "user", id: "user-id" },
		customer: { type: "company", id: "company-id" },
		deal_id: "deal-id",
		ticket_id: "ticket-id",
		project_id: "project-id",
	});
});

test("buildTaskCreatePayload omits absent optional values", () => {
	assert.deepEqual(buildTaskCreatePayload({
		title: "Préparer le devis",
		due_on: "2026-09-15",
		work_type_id: "work-type-id",
	}), {
		title: "Préparer le devis",
		due_on: "2026-09-15",
		work_type_id: "work-type-id",
	});
});

test("findTaskDuplicate requires the same normalized title and due date", () => {
	const normalize = (value: string) => value.trim().toLocaleLowerCase("fr-FR");
	const tasks = [
		{ id: "wrong-date", title: "Relancer le client", due_on: "2026-09-13" },
		{ id: "duplicate", title: "  RELANCER LE CLIENT ", due_on: "2026-09-14" },
	];
	assert.equal(findTaskDuplicate(tasks, "Relancer le client", "2026-09-14", normalize)?.id, "duplicate");
	assert.equal(findTaskDuplicate(tasks, "Préparer le devis", "2026-09-14", normalize), undefined);
});

test("duplicate detection reads later pages and includes completed tasks", async () => {
	const pages: number[] = [];
	const found = await checkTaskDuplicate(async (_endpoint, body: any) => {
		assert.equal(body.filter.term, undefined);
		assert.equal(body.filter.completed, undefined);
		pages.push(body.page.number);
		return { data: body.page.number === 1 ? Array.from({length:100}, (_,i) => ({id:String(i),title:"Other",due_on:"2026-09-14"})) : [{id:"existing",title:"Imported",due_on:"2026-09-14",completed:true}] };
	}, { due_from:"2026-09-14",due_by:"2026-09-14" }, "Imported", "2026-09-14", x=>x.toLowerCase());
	assert.equal(found?.id,"existing");
	assert.deepEqual(pages,[1,2]);
});

test("duplicate detection fails closed on malformed responses", async () => {
	await assert.rejects(checkTaskDuplicate(async()=>({error:"unavailable"}),{},"Task","2026-09-14",x=>x), /creation stopped/);
});
