import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CheckRegistry, parseChecks } from "../src/checks/registry.js";
import { Store } from "../src/store/db.js";
import { makeRoots } from "./helpers.js";

let dir: string;
let store: Store;
let checks: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-remove-"));
  checks = path.join(dir, "project-checks");
  fs.mkdirSync(checks);
  store = new Store(path.join(dir, "data"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const registry = () => new CheckRegistry(store, path.join(dir, "user-checks"), () => [checks]);
const write = (name: string, text: string) => fs.writeFileSync(path.join(checks, name), text);
const read = (name: string) => fs.readFileSync(path.join(checks, name), "utf8");

// A check that no longer validates (flag_at_level is outside its two levels) stays in the file
// until someone fixes it; deleting a neighbour must not delete it too.
const team = `# Team checks for the refund agent

- id: too-many-lookups
  kind: rule
  rule: { type: count, span: { type: tool, name: lookup_order }, at_least: 5 }
# WIP: fix the scale before turning this on
- id: refund-tone
  kind: score
  ask: How rude was the reply?
  levels: [calm, rude]
  flag_at_level: 7
- id: no-refund-loop
  kind: rule
  rule: { type: repeat, span: { type: tool, name: issue_refund }, same: [tool, input], at_least: 2 }
`;

it("deleting a check keeps the rest of its file, including checks that don't validate and comments", () => {
  write("refunds.yaml", team);
  const r = registry();
  expect(r.errors.map((e) => e.id)).toEqual(["refund-tone"]);
  expect(r.remove("too-many-lookups")).toBe(true);
  const text = read("refunds.yaml");
  expect(text).not.toContain("too-many-lookups");
  expect(text).toContain("# Team checks for the refund agent");
  expect(text).toContain("# WIP: fix the scale before turning this on\n- id: refund-tone");
  expect(text).toContain("flag_at_level: 7");
  const left = parseChecks(text);
  expect(left.checks.map((c) => c.id)).toEqual(["no-refund-loop"]);
  expect(left.errors.map((e) => e.id)).toEqual(["refund-tone"]);
  expect(r.get("too-many-lookups")).toBeUndefined();
  expect(r.get("no-refund-loop")?.source).toBe("project");
});

it("keeps a file whose last valid check is deleted while an invalid one is still in it", () => {
  write("refunds.yaml", team);
  const r = registry();
  r.remove("too-many-lookups");
  r.remove("no-refund-loop");
  expect(fs.existsSync(path.join(checks, "refunds.yaml"))).toBe(true);
  const left = parseChecks(read("refunds.yaml"));
  expect(left.checks).toEqual([]);
  expect(left.errors.map((e) => e.id)).toEqual(["refund-tone"]);
});

it("removes a file once its only check is deleted", () => {
  write("solo.yaml", "id: solo\nkind: rule\nrule: { type: count, span: { type: tool }, at_least: 3 }\n");
  write("list.yaml", "- id: listed\n  kind: rule\n  rule: { type: count, span: { type: tool }, at_least: 3 }\n");
  const r = registry();
  expect(r.remove("solo")).toBe(true);
  expect(r.remove("listed")).toBe(true);
  expect(fs.existsSync(path.join(checks, "solo.yaml"))).toBe(false);
  expect(fs.existsSync(path.join(checks, "list.yaml"))).toBe(false);
});

it("edits only the document holding the check and leaves the other documents as written", () => {
  const broken = "---\n# alias typo, reported as an error\nid: broken\nkind: rule\nrule: *missing\n";
  const single = "---\nid: single\nkind: rule\nrule: {type: count, span: {type: tool}, at_least: 4}\n";
  write(
    "mixed.yaml",
    `checks:\n  - id: first # keep me\n    kind: rule\n    rule: {type: count, span: {type: llm}, at_least: 9}\n  - id: second\n    kind: rule\n    rule: {type: count, span: {type: tool}, at_least: 2}\n${broken}${single}`,
  );
  const r = registry();
  r.remove("second");
  let text = read("mixed.yaml");
  expect(text).toContain("- id: first # keep me");
  expect(text).not.toContain("second");
  expect(text).toContain(broken);
  expect(text.endsWith(single)).toBe(true);
  r.remove("single");
  text = read("mixed.yaml");
  expect(text).not.toContain("id: single");
  expect(text).toContain(broken);
  expect(parseChecks(text).checks.map((c) => c.id)).toEqual(["first"]);
});

it("leaves a file alone when the check was already edited out of it by hand", () => {
  write("solo.yaml", "id: solo\nkind: rule\nrule: { type: count, span: { type: tool }, at_least: 3 }\n");
  const r = registry();
  write("solo.yaml", "# moved to another file\n");
  expect(r.remove("solo")).toBe(true);
  expect(read("solo.yaml")).toBe("# moved to another file\n");
});

it("DELETE /api/checks/:id keeps the other checks in a project file", async () => {
  write("refunds.yaml", team);
  const t = await makeRoots({ serve: true, noEngine: true, config: (c) => (c.checkDirs = [checks]) });
  try {
    const res = await fetch(`${t.url}/api/checks/too-many-lookups`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(read("refunds.yaml")).toContain("id: refund-tone");
    expect(t.roots.checks.get("no-refund-loop")).toBeDefined();
  } finally {
    await t.close();
  }
});

it("removes every copy of the id in the file, so an earlier duplicate doesn't come back", () => {
  write("dupes.yaml", "- id: dup\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 1}\n- id: other\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 2}\n- id: dup\n  kind: rule\n  rule: {type: count, span: {type: tool}, at_least: 3}\n");
  const r = registry();
  r.remove("dup");
  expect(r.get("dup")).toBeUndefined();
  expect(parseChecks(read("dupes.yaml")).checks.map((c) => c.id)).toEqual(["other"]);
});
