import { CLASSIFICATION } from "../src/catalog/classification.ts";
import { type OperationId, OPERATIONS } from "../src/catalog/operations.gen.ts";

// Prints the operation classification as a Markdown table, for the design
// document's appendix:
//
//   node scripts/render-classification.ts

const SCOPE_LABELS: Record<string, string> = {
	path: "path の gid",
	body: "リクエストボディ",
	query: "クエリ",
	workspace: "workspace 全体",
	filter: "結果をフィルタ",
	batch: "複合（各 action を個別に判定）",
};

const rows = (Object.keys(OPERATIONS) as OperationId[]).map((id) => {
	const spec = OPERATIONS[id];
	const rule = CLASSIFICATION[id];
	const action = rule.action === undefined ? "—" : `\`${rule.action}\``;
	const scope = SCOPE_LABELS[rule.scope] ?? rule.scope;
	const flags = spec.deprecated ? " (deprecated)" : "";
	return `| \`${id}\` | \`${spec.method} ${spec.path}\`${flags} | ${action} | ${scope} |`;
});
console.log("| operation | endpoint | action | スコープの解決 |");
console.log("| --- | --- | --- | --- |");
console.log(rows.join("\n"));
