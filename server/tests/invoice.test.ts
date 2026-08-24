import assert from "node:assert/strict";
import test from "node:test";
import { buildDraftInvoicePayload } from "../src/invoice.ts";

test("buildDraftInvoicePayload matches Teamleader invoices.draft", () => {
	assert.deepEqual(buildDraftInvoicePayload({
		customer_type: "company",
		customer_id: "customer-id",
		department_id: "department-id",
		invoice_date: "2026-08-24",
		payment_term: { type: "after_invoice_date", days: 30 },
		currency: "EUR",
		currency_exchange_rate: 1,
		purchase_order_number: "PO-42",
		lines: [{
			section_title: "Honoraires",
			description: "Conseil",
			quantity: 2,
			unit_price_excluding_tax: 125,
			tax_rate_id: "tax-id",
			discount_percentage: 10,
		}],
	}), {
		invoicee: { customer: { type: "company", id: "customer-id" } },
		department_id: "department-id",
		invoice_date: "2026-08-24",
		payment_term: { type: "after_invoice_date", days: 30 },
		currency: { code: "EUR", exchange_rate: 1 },
		grouped_lines: [{
			section: { title: "Honoraires" },
			line_items: [{
				description: "Conseil",
				quantity: 2,
				tax_rate_id: "tax-id",
				unit_price: { amount: 125, tax: "excluding" },
				discount: { type: "percentage", value: 10 },
			}],
		}],
		purchase_order_number: "PO-42",
	});
});
