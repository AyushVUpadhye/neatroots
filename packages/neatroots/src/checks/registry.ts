import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { AnyCheck, isQuestion, isRule, type Check, type CheckSource, type LoadedCheck } from "./types.js";
import type { Store } from "../store/db.js";
import { log } from "../util/log.js";

function findLibraryDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "library");
    if (fs.existsSync(path.join(candidate, "rules.yaml"))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("neatroots could not find its check library");
}

export interface CheckLoadError {
  path: string;
  id?: string;
  message: string;
}

/** Parses YAML holding one check, a list of checks, or `{checks: [...]}`. */
export function parseChecks(text: string): { checks: Check[]; errors: { id?: string; message: string }[] } {
  const checks: Check[] = [];
  const errors: { id?: string; message: string }[] = [];
  for (const doc of YAML.parseAllDocuments(text)) {
    if (doc.errors.length) {
      errors.push({ message: doc.errors.map((e) => e.message).join("; ") });
      continue;
    }
    let value: unknown;
    try {
      value = doc.toJS();
    } catch (e) {
      errors.push({ message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (value === null || value === undefined) continue;
    const items = Array.isArray(value)
      ? value
      : typeof value === "object" && Array.isArray((value as { checks?: unknown }).checks)
        ? (value as { checks: unknown[] }).checks
        : [value];
    for (const item of items) {
      const parsed = AnyCheck.safeParse(item);
      if (parsed.success) checks.push(parsed.data as Check);
      else {
        const id = (item as { id?: string })?.id;
        errors.push({ id, message: parsed.error.issues.map((i) => `${i.path.join(".") || "check"}: ${i.message}`).join("; ") });
      }
    }
  }
  return { checks, errors };
}

interface FoundCheck {
  doc: YAML.Document.Parsed;
  node: YAML.YAMLMap;
  /** The list holding the check; undefined when the check is the whole document. */
  list?: YAML.YAMLSeq;
}

/** Every check with this id in a checks file: a document of its own, or an entry of a list or `checks:`. */
function findChecks(text: string, id: string): FoundCheck[] {
  const isOurs = (n: unknown): n is YAML.YAMLMap => YAML.isMap(n) && n.get("id") === id && !!n.range;
  const found: FoundCheck[] = [];
  for (const doc of YAML.parseAllDocuments(text)) {
    if (doc.errors.length) continue;
    const contents = doc.contents;
    if (isOurs(contents)) {
      found.push({ doc, node: contents });
      continue;
    }
    const wrapped = YAML.isMap(contents) ? contents.get("checks", true) : undefined;
    const list = YAML.isSeq(contents) ? contents : YAML.isSeq(wrapped) ? wrapped : undefined;
    for (const node of list?.items ?? []) if (isOurs(node)) found.push({ doc, node, list });
  }
  return found;
}

/** The text a check takes up: its document, its "- " entry, or its flow entry and one comma. */
function textOf(text: string, { doc, node, list }: FoundCheck): [number, number] {
  const [start, end] = node.range!;
  if (!list) return [doc.range[0], doc.range[2]];
  if (list.flow) {
    const after = /^\s*,\s*/.exec(text.slice(end));
    if (after) return [start, end + after[0].length];
    const before = /,\s*$/.exec(text.slice(0, start));
    return [before ? before.index : start, end];
  }
  // A block entry runs from the start of its "- " line to the end of its last line.
  const marker = /(^|\n)[ \t]*-\s+$/.exec(text.slice(0, start));
  return [marker ? marker.index + marker[1].length : start, end];
}

/**
 * Cuts every check with this id out of a checks file; all other text stays exactly as written:
 * comments, other checks (including ones that don't validate yet) and other documents. Throws when
 * another check uses a YAML anchor the removed one defines, since that check would stop loading.
 */
function removeFromYaml(text: string, id: string): string {
  const found = findChecks(text, id);
  const removed = (pos: number) => found.some(({ node }) => pos >= node.range![0] && pos < node.range![1]);
  for (const { doc, node, list } of found) {
    const anchors = new Set<string>();
    YAML.visit(node, { Node: (_, n) => void (n.anchor && anchors.add(n.anchor)) });
    if (node.anchor) anchors.add(node.anchor);
    if (!anchors.size) continue;
    YAML.visit(doc, {
      Alias: (_, a) => {
        if (!anchors.has(a.source) || !a.range || removed(a.range[0])) return;
        const user = list?.items.find((n) => YAML.isMap(n) && n.range && a.range![0] >= n.range[0] && a.range![0] < n.range[1]);
        const name = YAML.isMap(user) ? `check ${String(user.get("id"))}` : "another check";
        throw new Error(`can't delete check ${id}: ${name} uses its YAML anchor &${a.source}. Replace *${a.source} there with the value, then delete ${id}.`);
      },
    });
  }
  let out = text;
  for (const [start, end] of found.map((f) => textOf(text, f)).reverse()) out = out.slice(0, start) + out.slice(end);
  return out;
}

/**
 * Rewrites every check with this id in a checks file and leaves all other text as written:
 * comments, other checks (including ones that don't validate yet) and other documents.
 * Returns undefined when the file has no check with this id.
 */
function replaceInYaml(text: string, check: Check): string | undefined {
  const spans = findChecks(text, check.id).map(({ node }) => ({ start: node.range![0], end: node.range![1], node }));
  if (!spans.length) return undefined;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let out = text;
  for (const { start, end, node } of spans.reverse()) {
    let next: string;
    if (node.flow) next = YAML.stringify(check, { collectionStyle: "flow", lineWidth: 0 }).trimEnd();
    else {
      // A block mapping's text runs to the end of its last line; continue at its column.
      const pad = " ".repeat(start - (text.lastIndexOf("\n", start - 1) + 1));
      next = checkToYaml(check).trimEnd().split("\n").join(`${eol}${pad}`) + eol;
    }
    out = out.slice(0, start) + next + out.slice(end);
  }
  return out;
}

export function checkToYaml(check: Check): string {
  return YAML.stringify(check, { lineWidth: 100 });
}

/**
 * All checks in force: the shipped library, then ~/.neatroots/checks, then each project's
 * .neatroots/checks, then checks written by the planner or over MCP. A later source replaces
 * an earlier check with the same id.
 */
export class CheckRegistry {
  private checks = new Map<string, LoadedCheck>();
  errors: CheckLoadError[] = [];
  readonly libraryDir = findLibraryDir();

  constructor(
    private readonly store: Store,
    private readonly userDir: string,
    private readonly projectDirs: () => string[],
  ) {
    this.reload();
  }

  reload(): void {
    const next = new Map<string, LoadedCheck>();
    const errors: CheckLoadError[] = [];
    const loadDir = (dir: string, source: CheckSource) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir).sort()) {
        if (!/\.ya?ml$/i.test(f)) continue;
        const p = path.join(dir, f);
        const { checks, errors: errs } = parseChecks(fs.readFileSync(p, "utf8"));
        for (const e of errs) errors.push({ path: p, ...e });
        for (const c of checks) next.set(c.id, { check: c, source, path: p });
      }
    };
    loadDir(this.libraryDir, "library");
    loadDir(this.userDir, "user");
    for (const d of this.projectDirs()) loadDir(d, "project");
    const rows = this.store.db
      .prepare("SELECT id, source, body FROM checks WHERE source IN ('planner', 'mcp')")
      .all() as { id: string; source: CheckSource; body: string }[];
    for (const r of rows) {
      if (next.has(r.id)) continue;
      const { checks } = parseChecks(r.body);
      if (checks[0]) next.set(r.id, { check: checks[0], source: r.source, path: null });
    }
    for (const [id, lc] of next) {
      this.store.upsertCheckRow({ id, kind: lc.check.kind === "rule" ? "rule" : "question", source: lc.source, path: lc.path, body: checkToYaml(lc.check), enabled: lc.check.enabled });
    }
    this.checks = next;
    const seen = new Set(this.errors.map((e) => `${e.path}|${e.id}|${e.message}`));
    this.errors = errors;
    for (const e of errors) if (!seen.has(`${e.path}|${e.id}|${e.message}`)) log.warn(`check ${e.id ?? ""} in ${e.path}: ${e.message.split("\n")[0]}`);
  }

  get(id: string): LoadedCheck | undefined {
    return this.checks.get(id);
  }

  all(): LoadedCheck[] {
    return [...this.checks.values()];
  }

  enabled(): LoadedCheck[] {
    const stats = this.store.checkStats();
    return this.all().filter((c) => c.check.enabled !== false && (stats[c.check.id]?.enabled ?? 1) === 1);
  }

  rules(): LoadedCheck[] {
    return this.enabled().filter((c) => isRule(c.check));
  }

  questions(): LoadedCheck[] {
    return this.enabled().filter((c) => isQuestion(c.check));
  }

  library(): LoadedCheck[] {
    return this.all().filter((c) => c.source === "library" && isQuestion(c.check));
  }

  /**
   * Saves a check. `target` is "user" (~/.neatroots/checks), a project checks directory, or
   * "db" for planner-written checks that live only in the database until a person keeps them.
   * A check that already lives in a user or project file is updated in that file, unless
   * `target` names a different directory.
   */
  save(check: Check, target: "user" | "db" | { dir: string }, source: CheckSource = "user"): LoadedCheck {
    const parsed = AnyCheck.parse(check) as Check;
    let p: string | null = null;
    if (target === "db") {
      this.store.upsertCheckRow({ id: parsed.id, kind: parsed.kind === "rule" ? "rule" : "question", source, path: null, body: checkToYaml(parsed) });
    } else {
      const dir = target === "user" ? this.userDir : target.dir;
      // A new <id>.yaml next to the file the check is loaded from would be shadowed by it (project
      // directories load after the user one, files in name order), so the edit would be ignored.
      const current = this.checks.get(parsed.id);
      const inPlace =
        current?.path &&
        (current.source === "user" || current.source === "project") &&
        (target === "user" || path.resolve(path.dirname(current.path)) === path.resolve(dir)) &&
        fs.existsSync(current.path)
          ? replaceInYaml(fs.readFileSync(current.path, "utf8"), parsed)
          : undefined;
      if (inPlace !== undefined) {
        p = current!.path!;
        fs.writeFileSync(p, inPlace, "utf8");
      } else {
        fs.mkdirSync(dir, { recursive: true });
        p = path.join(dir, `${parsed.id}.yaml`);
        fs.writeFileSync(p, checkToYaml(parsed), "utf8");
      }
      if (source === "planner" || source === "mcp") source = target === "user" ? "user" : "project";
      this.store.db.prepare("DELETE FROM checks WHERE id = ? AND source IN ('planner', 'mcp')").run(parsed.id);
    }
    this.reload();
    return this.checks.get(parsed.id) ?? { check: parsed, source, path: p };
  }

  /** Removes a user or planner check (library checks can only be disabled). */
  remove(id: string): boolean {
    const lc = this.checks.get(id);
    if (!lc || lc.source === "library") return false;
    if (lc.path && fs.existsSync(lc.path)) {
      const before = fs.readFileSync(lc.path, "utf8");
      const text = removeFromYaml(before, id);
      const left = parseChecks(text);
      if (text === before) {
        /* edited by hand since it was loaded; nothing of this check left to remove */
      } else if (!left.checks.length && !left.errors.length) fs.unlinkSync(lc.path);
      else fs.writeFileSync(lc.path, text, "utf8");
    }
    this.store.db.prepare("DELETE FROM checks WHERE id = ?").run(id);
    this.reload();
    return true;
  }

  /** Precision per check from dismissals; noisy checks are suggested for retirement. */
  precision(id: string): { hits: number; dismissed: number; precision: number | null; noisy: boolean } {
    const s = this.store.checkStats()[id];
    if (!s || s.hits === 0) return { hits: s?.hits ?? 0, dismissed: s?.dismissed ?? 0, precision: null, noisy: false };
    const precision = 1 - s.dismissed / s.hits;
    return { hits: s.hits, dismissed: s.dismissed, precision, noisy: s.hits >= 5 && precision < 0.4 };
  }
}
