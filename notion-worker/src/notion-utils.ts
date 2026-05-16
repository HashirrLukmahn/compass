export type Props = Record<string, unknown>;

export function getTitle(props: Props, key: string): string {
	const prop = props[key] as { type?: string; title?: Array<{ plain_text?: string }> } | undefined;
	if (!prop || prop.type !== "title" || !prop.title) return "";
	return prop.title.map((t) => t.plain_text ?? "").join("");
}

export function getSelect(props: Props, key: string): string {
	const prop = props[key] as { type?: string; select?: { name?: string } | null } | undefined;
	if (!prop || prop.type !== "select" || !prop.select) return "";
	return prop.select.name ?? "";
}

export function getNumber(props: Props, key: string): number | null {
	const prop = props[key] as { type?: string; number?: number | null } | undefined;
	if (!prop || prop.type !== "number") return null;
	return prop.number ?? null;
}

export function getDate(props: Props, key: string): string | null {
	const prop = props[key] as { type?: string; date?: { start?: string } | null } | undefined;
	if (!prop || prop.type !== "date" || !prop.date) return null;
	return prop.date.start ?? null;
}

export function getRichText(props: Props, key: string): string {
	const prop = props[key] as
		| { type?: string; rich_text?: Array<{ plain_text?: string }> }
		| undefined;
	if (!prop || prop.type !== "rich_text" || !prop.rich_text) return "";
	return prop.rich_text.map((t) => t.plain_text ?? "").join("");
}

export function getUrl(props: Props, key: string): string | null {
	const prop = props[key] as { type?: string; url?: string | null } | undefined;
	if (!prop || prop.type !== "url") return null;
	return prop.url ?? null;
}

export function getMultiSelect(props: Props, key: string): string[] {
	const prop = props[key] as
		| { type?: string; multi_select?: Array<{ name?: string }> }
		| undefined;
	if (!prop || prop.type !== "multi_select" || !prop.multi_select) return [];
	return prop.multi_select.map((o) => o.name ?? "").filter(Boolean);
}

// Category is multi-select in this workspace; tolerate single-select too.
export function getCategory(props: Props, key: string): string {
	const multi = getMultiSelect(props, key);
	if (multi.length > 0) return multi[0];
	return getSelect(props, key);
}
