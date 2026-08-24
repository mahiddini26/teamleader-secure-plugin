export type DraftInvoicePaymentTerm =
	| { type: "cash" }
	| { type: "end_of_month" | "after_invoice_date"; days: number };

export type DraftInvoiceLine = {
	section_title?: string;
	description: string;
	extended_description?: string;
	quantity: number;
	unit_price_excluding_tax: number;
	tax_rate_id: string;
	discount_percentage?: number;
	unit_of_measure_id?: string;
	product_category_id?: string;
	product_id?: string;
	withholding_tax_rate_id?: string;
};

export type DraftInvoiceInput = {
	customer_type: "contact" | "company";
	customer_id: string;
	department_id: string;
	invoice_date: string;
	payment_term: DraftInvoicePaymentTerm;
	currency: string;
	currency_exchange_rate: number;
	purchase_order_number?: string;
	note?: string;
	project_id?: string;
	document_template_id?: string;
	lines: DraftInvoiceLine[];
};

export function buildDraftInvoicePayload(input: DraftInvoiceInput) {
	const grouped = new Map<string, DraftInvoiceLine[]>();
	for (const line of input.lines) {
		const section = line.section_title || "";
		grouped.set(section, [...(grouped.get(section) || []), line]);
	}

	return {
		invoicee: { customer: { type: input.customer_type, id: input.customer_id } },
		department_id: input.department_id,
		invoice_date: input.invoice_date,
		payment_term: input.payment_term,
		currency: { code: input.currency, exchange_rate: input.currency_exchange_rate },
		grouped_lines: [...grouped.entries()].map(([title, entries]) => ({
			...(title ? { section: { title } } : {}),
			line_items: entries.map(({
				section_title: _section,
				description,
				extended_description,
				quantity,
				unit_price_excluding_tax,
				tax_rate_id,
				discount_percentage,
				unit_of_measure_id,
				product_category_id,
				product_id,
				withholding_tax_rate_id,
			}) => ({
				description,
				quantity,
				tax_rate_id,
				unit_price: { amount: unit_price_excluding_tax, tax: "excluding" as const },
				...(extended_description ? { extended_description } : {}),
				...(discount_percentage !== undefined
					? { discount: { type: "percentage" as const, value: discount_percentage } }
					: {}),
				...(unit_of_measure_id ? { unit_of_measure_id } : {}),
				...(product_category_id ? { product_category_id } : {}),
				...(product_id ? { product_id } : {}),
				...(withholding_tax_rate_id ? { withholding_tax_rate_id } : {}),
			})),
		})),
		...(input.purchase_order_number ? { purchase_order_number: input.purchase_order_number } : {}),
		...(input.note ? { note: input.note } : {}),
		...(input.project_id ? { project_id: input.project_id } : {}),
		...(input.document_template_id ? { document_template_id: input.document_template_id } : {}),
	};
}
