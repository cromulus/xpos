/**
 * The till's customer rows in the Electron database (Mule City, MuleCity-qajl.4).
 *
 * Why: the browser caches each customer row whole (IndexedDB), with what the
 * site adds to it: the delivery details and addresses (`xpos_delivery`), the
 * contacts (`xpos_contacts`), the card's flags (`xpos_has_address`, ...). The
 * Electron `customers` table has fixed columns, and `upsertBatch` inserts every
 * key of the row, so those extra keys failed the insert (6nb1 noted the delivery
 * details went missing). A till opened offline in Electron must have the same
 * data as the browser.
 *
 * What: `packCustomerRows` keeps the table's own columns and puts every other
 * key in one JSON column, `xpos_row`; `unpackCustomerRow` merges it back.
 * Every packed row has the same keys, as `upsertBatch` requires.
 */

/** The `customers` table's columns (schema.sql), other than `xpos_row`. */
export const CUSTOMER_COLUMNS = [
	"name",
	"customer_name",
	"customer_group",
	"customer_type",
	"territory",
	"tax_category",
	"mobile_no",
	"email_id",
	"default_currency",
	"loyalty_program",
	"loyalty_points",
	"disabled",
	"modified",
	"synced_at",
	"is_local",
	"local_id",
] as const;

const COLUMN_SET = new Set<string>(CUSTOMER_COLUMNS);
export const EXTRA_COLUMN = "xpos_row";

/** Rows ready for `upsertBatch("customers", ...)`: the table's columns plus `xpos_row`. */
export function packCustomerRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
	const present = new Set<string>(["name", "customer_name", "disabled"]);
	for (const row of rows) for (const key of Object.keys(row)) if (COLUMN_SET.has(key)) present.add(key);
	const columns = CUSTOMER_COLUMNS.filter((column) => present.has(column));
	return rows.map((row) => {
		const packed: Record<string, unknown> = {};
		const extra: Record<string, unknown> = {};
		for (const column of columns) packed[column] = row[column] ?? null;
		// A row the till caches is an enabled customer (the site lists no disabled ones).
		if (packed.disabled === null) packed.disabled = 0;
		if (packed.customer_name === null) packed.customer_name = row.name ?? "";
		for (const [key, value] of Object.entries(row)) {
			if (!COLUMN_SET.has(key) && key !== EXTRA_COLUMN && value !== undefined) extra[key] = value;
		}
		packed[EXTRA_COLUMN] = Object.keys(extra).length ? JSON.stringify(extra) : null;
		return packed;
	});
}

/** A row read from the table, with its extra keys back in place. */
export function unpackCustomerRow<T extends Record<string, unknown> | null | undefined>(row: T): T {
	if (!row) return row;
	const { [EXTRA_COLUMN]: raw, ...columns } = row as Record<string, unknown>;
	if (typeof raw !== "string" || !raw) return columns as T;
	try {
		const extra = JSON.parse(raw) as Record<string, unknown>;
		return { ...extra, ...columns } as T;
	} catch {
		return columns as T;
	}
}
