export type Source = "sessions" | "events" | "messages" | "tools" | "chunks";
export type Scalar = string | number | boolean | null;
export type ValueNode =
  | { kind: "literal"; value: Scalar | Scalar[] }
  | { kind: "parameter"; name: string }
  | { kind: "field"; path: string };
export type Expression =
  | { kind: "compare"; operator: "=" | "!=" | "<" | "<=" | ">" | ">="; left: ValueNode; right: ValueNode }
  | { kind: "in"; negated?: boolean; left: ValueNode; right: ValueNode }
  | { kind: "null"; negated?: boolean; value: ValueNode }
  | { kind: "not"; item: Expression }
  | { kind: "and"; items: Expression[] }
  | { kind: "or"; items: Expression[] };
export type Stage =
  | { op: "where"; expression: Expression }
  | { op: "search"; kind: "text" | "semantic" | "hybrid"; query: ValueNode; hitsPerSession: number }
  | { op: "project"; fields: Array<{ kind: "field"; path: string; as?: string }> }
  | { op: "sort"; keys: Array<{ field: string; direction: "asc" | "desc" }> }
  | { op: "limit"; count: number };

export interface QueryPlan {
  irVersion: "1.0";
  asp: { eventSchema: "1.0"; projection: "1.1" };
  source: Source;
  stages: Stage[];
  parameters: Array<{ name: string; type: "string"; required: true }>;
  mode: "batch";
}

export class SessionQLError extends Error {
  readonly code: "parse_error" | "unsupported_capability";
  readonly retryable = false;
  readonly details = undefined;
  constructor(code: SessionQLError["code"], message: string) {
    super(message);
    this.name = "SessionQLError";
    this.code = code;
  }
}

const sources = new Set<Source>(["sessions", "events", "messages", "tools", "chunks"]);

interface Token {
  kind: "word" | "string" | "number" | "parameter" | "operator" | "punctuation";
  text: string;
  value?: Scalar;
}

function splitPipeline(input: string): string[] {
  const stages: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of input) {
    if (quote) {
      current += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
    } else if (character === "|") {
      stages.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (quote) throw new SessionQLError("parse_error", "unterminated string literal");
  stages.push(current.trim());
  return stages.filter(Boolean);
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const rest = input.slice(index);
    const whitespace = rest.match(/^\s+/);
    if (whitespace) { index += whitespace[0].length; continue; }
    const quote = input[index];
    if (quote === "'") throw new SessionQLError("parse_error", "strings must use JSON double quotes");
    if (quote === '"') {
      let escaped = false;
      let end = index + 1;
      for (; end < input.length; end++) {
        const character = input[end];
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) break;
      }
      if (end >= input.length) throw new SessionQLError("parse_error", "unterminated string literal");
      let value: string;
      try { value = JSON.parse(input.slice(index, end + 1)) as string; }
      catch { throw new SessionQLError("parse_error", "invalid string escape"); }
      tokens.push({ kind: "string", text: input.slice(index, end + 1), value });
      index = end + 1;
      continue;
    }
    const parameter = rest.match(/^\$([A-Za-z_][A-Za-z0-9_]*)/);
    if (parameter) { tokens.push({ kind: "parameter", text: parameter[1] }); index += parameter[0].length; continue; }
    const number = rest.match(/^-?\d+(?:\.\d+)?/);
    if (number) { tokens.push({ kind: "number", text: number[0], value: Number(number[0]) }); index += number[0].length; continue; }
    const operator = rest.match(/^(<=|>=|!=|=|<|>)/);
    if (operator) { tokens.push({ kind: "operator", text: operator[0] }); index += operator[0].length; continue; }
    if (["[", "]", ","].includes(input[index])) { tokens.push({ kind: "punctuation", text: input[index] }); index++; continue; }
    const word = rest.match(/^[A-Za-z_][A-Za-z0-9_.-]*/);
    if (word) { tokens.push({ kind: "word", text: word[0] }); index += word[0].length; continue; }
    throw new SessionQLError("parse_error", `unexpected character: ${input[index]}`);
  }
  return tokens;
}

class ExpressionParser {
  #index = 0;
  constructor(readonly tokens: Token[]) {}
  done(): boolean { return this.#index === this.tokens.length; }
  peek(text?: string): Token | undefined {
    const token = this.tokens[this.#index];
    if (text && token?.text.toLowerCase() !== text) return undefined;
    return token;
  }
  take(text?: string): Token {
    const token = this.peek(text);
    if (!token) throw new SessionQLError("parse_error", text ? `expected ${text}` : "unexpected end of expression");
    this.#index++;
    return token;
  }
  parse(): Expression { return this.parseOr(); }
  parseOr(): Expression {
    const items = [this.parseAnd()];
    while (this.peek("or")) { this.take(); items.push(this.parseAnd()); }
    return items.length === 1 ? items[0] : { kind: "or", items };
  }
  parseAnd(): Expression {
    const items = [this.parseUnary()];
    while (this.peek("and")) { this.take(); items.push(this.parseUnary()); }
    return items.length === 1 ? items[0] : { kind: "and", items };
  }
  parseUnary(): Expression {
    if (this.peek("not")) { this.take(); return { kind: "not", item: this.parseUnary() }; }
    const left = this.value();
    if (this.peek("is")) {
      this.take();
      const negated = Boolean(this.peek("not"));
      if (negated) this.take();
      this.take("null");
      return { kind: "null", ...(negated ? { negated: true } : {}), value: left };
    }
    let negated = false;
    if (this.peek("not")) { this.take(); negated = true; }
    if (this.peek("in")) {
      this.take();
      return { kind: "in", ...(negated ? { negated: true } : {}), left, right: this.value() };
    }
    if (negated) throw new SessionQLError("parse_error", "expected in after not");
    const operator = this.take();
    if (operator.kind !== "operator") throw new SessionQLError("parse_error", "expected comparison operator");
    return { kind: "compare", operator: operator.text as Extract<Expression, {kind:"compare"}>["operator"], left, right: this.value() };
  }
  value(): ValueNode {
    const token = this.take();
    if (token.kind === "string" || token.kind === "number") return { kind: "literal", value: token.value! };
    if (token.kind === "parameter") return { kind: "parameter", name: token.text };
    if (token.text === "true" || token.text === "false") return { kind: "literal", value: token.text === "true" };
    if (token.text === "null") return { kind: "literal", value: null };
    if (token.text === "[") {
      const values: Scalar[] = [];
      while (!this.peek("]")) {
        const item = this.value();
        if (item.kind !== "literal" || Array.isArray(item.value)) throw new SessionQLError("parse_error", "arrays may only contain literals");
        values.push(item.value);
        if (!this.peek(",")) break;
        this.take();
      }
      this.take("]");
      return { kind: "literal", value: values };
    }
    if (token.kind === "word") return { kind: "field", path: token.text };
    throw new SessionQLError("parse_error", "expected value");
  }
}

function parseExpression(input: string): Expression {
  const parser = new ExpressionParser(tokenize(input));
  const expression = parser.parse();
  if (!parser.done()) throw new SessionQLError("parse_error", "unexpected tokens after expression");
  return expression;
}

function valueFromToken(input: string): ValueNode {
  const parser = new ExpressionParser(tokenize(input));
  const value = parser.value();
  if (!parser.done()) throw new SessionQLError("parse_error", "search query must be one literal or parameter");
  if (value.kind === "field") throw new SessionQLError("parse_error", "search query must be a literal or parameter");
  return value;
}

function parametersIn(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) parametersIn(item, output);
  else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (object.kind === "parameter" && typeof object.name === "string") output.add(object.name);
    for (const item of Object.values(object)) parametersIn(item, output);
  }
  return output;
}

const eventFields = new Set([
  "globalSeq", "seq", "sessionId", "eventId",
  "event.type", "event.timestamp", "event.eventId", "event.sessionId",
  "event.correlation.agentSessionId", "event.correlation.runId", "event.correlation.turnId",
  "event.correlation.messageId", "event.correlation.toolCallId", "event.correlation.toolResultId",
  "event.correlation.parentId", "event.correlation.clientActionId",
]);

function fieldsIn(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) fieldsIn(item, output);
  else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (object.kind === "field" && typeof object.path === "string") output.add(object.path);
    for (const item of Object.values(object)) fieldsIn(item, output);
  }
  return output;
}

export function parseSessionQL(input: string): QueryPlan {
  const parts = splitPipeline(input);
  const head = parts.shift()?.match(/^from\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (!head || !sources.has(head[1] as Source)) throw new SessionQLError("parse_error", "invalid or unsupported query source");
  const stages: Stage[] = [];
  for (const text of parts) {
    const where = text.match(/^where\s+(.+)$/is);
    if (where) { stages.push({ op: "where", expression: parseExpression(where[1]) }); continue; }
    const search = text.match(/^search\s+(text|semantic|hybrid)\s+(.+)$/is);
    if (search) {
      stages.push({
        op: "search",
        kind: search[1].toLowerCase() as "text" | "semantic" | "hybrid",
        query: valueFromToken(search[2]),
        hitsPerSession: 3,
      });
      continue;
    }
    const project = text.match(/^project\s+(.+)$/is);
    if (project) {
      const fields = project[1].split(",").map(field => field.trim()).map(field => {
        if (!field.match(/^[A-Za-z_][A-Za-z0-9_.-]*$/)) throw new SessionQLError("parse_error", `invalid projection field: ${field}`);
        return { kind: "field" as const, path: field };
      });
      stages.push({ op: "project", fields }); continue;
    }
    const sort = text.match(/^sort\s+by\s+(.+)$/is);
    if (sort) {
      const keys = sort[1].split(",").map(key => key.trim()).map(key => {
        const match = key.match(/^([A-Za-z_][A-Za-z0-9_.-]*)(?:\s+(asc|desc))?$/i);
        if (!match) throw new SessionQLError("parse_error", `invalid sort key: ${key}`);
        return { field: match[1], direction: (match[2]?.toLowerCase() ?? "asc") as "asc"|"desc" };
      });
      stages.push({ op: "sort", keys }); continue;
    }
    const limit = text.match(/^limit\s+(\d+)$/i);
    if (limit) {
      const count = Number(limit[1]);
      if (count > 1_000) throw new SessionQLError("unsupported_capability", "limit exceeds the foundation maximum of 1000");
      stages.push({ op: "limit", count }); continue;
    }
    throw new SessionQLError("unsupported_capability", `unsupported SessionQL stage: ${text.split(/\s+/)[0]}`);
  }
  const projectIndex = stages.findIndex(stage => stage.op === "project");
  if (projectIndex >= 0 && stages.slice(projectIndex + 1).some(stage => stage.op !== "limit")) {
    throw new SessionQLError("unsupported_capability", "foundation project may only be followed by limit");
  }
  const parameterNames = [...parametersIn(stages)].sort();
  if (head[1] === "events") {
    for (const field of fieldsIn(stages)) {
      if (!eventFields.has(field)) throw new SessionQLError("parse_error", `unknown events field: ${field}`);
    }
  }
  return {
    irVersion: "1.0",
    asp: { eventSchema: "1.0", projection: "1.1" },
    source: head[1] as Source,
    stages,
    parameters: parameterNames.map(name => ({ name, type: "string", required: true })),
    mode: "batch",
  };
}

function printValue(value: ValueNode): string {
  if (value.kind === "field") return value.path;
  if (value.kind === "parameter") return `$${value.name}`;
  return JSON.stringify(value.value);
}

function printExpression(expression: Expression): string {
  if (expression.kind === "compare") return `${printValue(expression.left)} ${expression.operator} ${printValue(expression.right)}`;
  if (expression.kind === "in") return `${printValue(expression.left)}${expression.negated ? " not" : ""} in ${printValue(expression.right)}`;
  if (expression.kind === "null") return `${printValue(expression.value)} is${expression.negated ? " not" : ""} null`;
  if (expression.kind === "not") return `not ${printExpression(expression.item)}`;
  return expression.items.map(printExpression).join(` ${expression.kind} `);
}

export function printSessionQL(plan: QueryPlan): string {
  let output = `from ${plan.source}`;
  for (const stage of plan.stages) {
    if (stage.op === "where") output += ` | where ${printExpression(stage.expression)}`;
    else if (stage.op === "search") output += ` | search ${stage.kind} ${printValue(stage.query)}`;
    else if (stage.op === "project") output += ` | project ${stage.fields.map(field => field.path).join(", ")}`;
    else if (stage.op === "sort") output += ` | sort by ${stage.keys.map(key => `${key.field} ${key.direction}`).join(", ")}`;
    else output += ` | limit ${stage.count}`;
  }
  return output;
}
