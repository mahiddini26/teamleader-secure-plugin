export type TaskCreateInput = {
	title: string;
	description?: string;
	due_on: string;
	work_type_id: string;
	estimated_duration_minutes?: number;
	assignee_type?: "user" | "team";
	assignee_id?: string;
	customer_type?: "contact" | "company";
	customer_id?: string;
	deal_id?: string;
	ticket_id?: string;
	project_id?: string;
};

export type ExistingTask = {
	id?: string;
	title?: string;
	due_on?: string;
};

export function buildTaskCreatePayload(input: TaskCreateInput) {
	return {
		title: input.title,
		...(input.description ? { description: input.description } : {}),
		due_on: input.due_on,
		work_type_id: input.work_type_id,
		...(input.estimated_duration_minutes
			? { estimated_duration: { unit: "min", value: input.estimated_duration_minutes } }
			: {}),
		...(input.assignee_type && input.assignee_id
			? { assignee: { type: input.assignee_type, id: input.assignee_id } }
			: {}),
		...(input.customer_type && input.customer_id
			? { customer: { type: input.customer_type, id: input.customer_id } }
			: {}),
		...(input.deal_id ? { deal_id: input.deal_id } : {}),
		...(input.ticket_id ? { ticket_id: input.ticket_id } : {}),
		...(input.project_id ? { project_id: input.project_id } : {}),
	};
}

export function findTaskDuplicate(
	tasks: ExistingTask[],
	title: string,
	dueOn: string,
	normalize: (value: string) => string,
) {
	return tasks.find((task) =>
		normalize(task.title || "") === normalize(title) && task.due_on === dueOn,
	);
}

export async function checkTaskDuplicate(
	call: (endpoint: string, body: Record<string, unknown>) => Promise<unknown>,
	filter: Record<string, unknown>, title: string, dueOn: string,
	normalize: (value: string) => string,
) {
	// tasks.list.term searches descriptions, not titles. Read all matching dates.
	for (let number = 1; number <= 100; number++) {
		const response = await call("tasks.list", { filter, page: { number, size: 100 } }) as { data?: ExistingTask[] };
		if (!Array.isArray(response.data)) throw new Error("Unable to verify existing tasks; creation stopped");
		const duplicate = findTaskDuplicate(response.data, title, dueOn, normalize);
		if (duplicate) return duplicate;
		if (response.data.length < 100) return undefined;
	}
	throw new Error("Duplicate search incomplete; creation stopped");
}
