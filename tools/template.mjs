/**
 * A tiny template engine for the rendered process files (zero dependencies).
 *
 *   {{ name }}            value (dotted paths ok: {{ policy.names.gateContext }}); missing ⇒ error
 *   {{#if name}}…{{else}}…{{/if}}       truthy (non-empty arrays/objects, non-empty strings, true, non-zero)
 *   {{#unless name}}…{{/unless}}
 *   {{#each list}}…{{/each}}            inside: {{ this }} / {{ this.field }}, {{ @index }}, {{ @first }}, {{ @last }}
 *   {{#eq name "value"}}…{{else}}…{{/eq}}   string equality
 *   {{! comment }}                       removed
 *
 * `${{ … }}` (GitHub Actions expressions) is never touched: a `{{` right after `$` is literal text.
 * A block tag alone on its line takes the whole line with it, so templates can be indented naturally.
 */

const OPEN = /(?<!\$)\{\{\s*([#/!]?)\s*([^}]*?)\s*\}\}/g;

function lookup(ctx, path) {
  if (path === "this") return ctx.this;
  let cur = ctx;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

const truthy = (v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.keys(v).length > 0 : Boolean(v));

/** Tokenize into text / var / open / close / else nodes, swallowing whole lines that hold only a block tag. */
function tokenize(src) {
  const tokens = [];
  let last = 0;
  for (const m of src.matchAll(OPEN)) {
    const [whole, sigil, body] = m;
    let start = m.index;
    let end = start + whole.length;
    const isBlock = sigil === "#" || sigil === "/" || sigil === "!" || body === "else";
    if (isBlock) {
      const lineStart = src.lastIndexOf("\n", start - 1) + 1;
      const nl = src.indexOf("\n", end);
      const lineEnd = nl === -1 ? src.length : nl + 1;
      if (/^[ \t]*$/.test(src.slice(lineStart, start)) && /^[ \t]*\r?\n?$/.test(src.slice(end, lineEnd)) && lineStart >= last) {
        start = lineStart;
        end = lineEnd;
      }
    }
    if (start > last) tokens.push({ t: "text", v: src.slice(last, start) });
    if (sigil === "!") {
      // comment
    } else if (sigil === "#") {
      const [kind, ...rest] = body.split(/\s+/);
      tokens.push({ t: "open", kind, arg: rest.join(" ") });
    } else if (sigil === "/") tokens.push({ t: "close", kind: body });
    else if (body === "else") tokens.push({ t: "else" });
    else tokens.push({ t: "var", v: body });
    last = end;
  }
  if (last < src.length) tokens.push({ t: "text", v: src.slice(last) });
  return tokens;
}

function parse(tokens) {
  const root = { children: [] };
  const stack = [root];
  for (const tok of tokens) {
    const top = stack.at(-1);
    const into = top.inElse ? top.elseChildren : top.children;
    if (tok.t === "open") {
      const node = { ...tok, children: [], elseChildren: [], inElse: false };
      into.push(node);
      stack.push(node);
    } else if (tok.t === "else") {
      if (stack.length === 1) throw new Error("template: {{else}} outside a block");
      top.inElse = true;
    } else if (tok.t === "close") {
      if (stack.length === 1 || top.kind !== tok.kind) throw new Error(`template: unexpected {{/${tok.kind}}}`);
      stack.pop();
    } else into.push(tok);
  }
  if (stack.length !== 1) throw new Error(`template: unclosed {{#${stack.at(-1).kind}}}`);
  return root.children;
}

function run(nodes, ctx, name) {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.v;
    else if (n.t === "var") {
      const v = lookup(ctx, n.v);
      if (v === undefined || v === null) throw new Error(`template ${name}: missing value "${n.v}"`);
      out += String(v);
    } else if (n.kind === "if" || n.kind === "unless") {
      const yes = truthy(lookup(ctx, n.arg));
      out += run((n.kind === "if") === yes ? n.children : n.elseChildren, ctx, name);
    } else if (n.kind === "eq") {
      const m = /^([\w.@]+)\s+"([^"]*)"$/.exec(n.arg);
      if (!m) throw new Error(`template ${name}: bad {{#eq ${n.arg}}}`);
      out += run(String(lookup(ctx, m[1])) === m[2] ? n.children : n.elseChildren, ctx, name);
    } else if (n.kind === "each") {
      const list = lookup(ctx, n.arg) ?? [];
      if (!Array.isArray(list)) throw new Error(`template ${name}: {{#each ${n.arg}}} is not a list`);
      if (!list.length) out += run(n.elseChildren, ctx, name);
      list.forEach((item, i) => {
        out += run(n.children, { ...ctx, this: item, "@index": i, "@first": i === 0, "@last": i === list.length - 1 }, name);
      });
    } else throw new Error(`template ${name}: unknown block {{#${n.kind}}}`);
  }
  return out;
}

/** Render `src` with `ctx`; `name` only labels errors. */
export function renderTemplate(src, ctx, name = "template") {
  return run(parse(tokenize(src)), ctx, name);
}
