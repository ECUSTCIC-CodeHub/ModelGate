const REGEX_MAX_LENGTH = 512;
const REGEX_TIMEOUT_MS = 50;

function safeRegexTest(re: RegExp, input: string): boolean {
  if (input.length > 4096) return false;
  const start = performance.now();
  const result = re.test(input);
  if (performance.now() - start > REGEX_TIMEOUT_MS) {
    throw new Error("regex timeout");
  }
  return result;
}

type ComparisonNode = {
  type: "comparison";
  path: string;
  operator: "==" | "!=" | "contains" | "matches" | "exists";
  value: string;
};

type LogicalNode = {
  type: "and" | "or";
  left: ExprNode;
  right: ExprNode;
};

export type ExprNode = ComparisonNode | LogicalNode;

type Token =
  | { type: "IDENT"; value: string }
  | { type: "STRING"; value: string }
  | { type: "OP"; value: "==" | "!=" | "contains" | "matches" | "exists" }
  | { type: "AND" }
  | { type: "OR" }
  | { type: "LPAREN" }
  | { type: "RPAREN" }
  | { type: "EOF" };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    if (/\s/.test(input[i])) { i++; continue; }

    if (input[i] === "(") { tokens.push({ type: "LPAREN" }); i++; continue; }
    if (input[i] === ")") { tokens.push({ type: "RPAREN" }); i++; continue; }

    if (input[i] === "=" && input[i + 1] === "=") {
      tokens.push({ type: "OP", value: "==" }); i += 2; continue;
    }
    if (input[i] === "!" && input[i + 1] === "=") {
      tokens.push({ type: "OP", value: "!=" }); i += 2; continue;
    }

    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      let str = "";
      i++;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < input.length) {
          str += input[i + 1]; i += 2;
        } else {
          str += input[i]; i++;
        }
      }
      if (i >= input.length) throw new Error("未闭合的字符串引号");
      i++;
      tokens.push({ type: "STRING", value: str });
      continue;
    }

    if (/[A-Za-z_]/.test(input[i])) {
      let word = "";
      while (i < input.length && /[A-Za-z0-9_.]/.test(input[i])) {
        word += input[i]; i++;
      }
      if (word === "AND") tokens.push({ type: "AND" });
      else if (word === "OR") tokens.push({ type: "OR" });
      else if (word === "contains") tokens.push({ type: "OP", value: "contains" });
      else if (word === "matches") tokens.push({ type: "OP", value: "matches" });
      else if (word === "exists") tokens.push({ type: "OP", value: "exists" });
      else tokens.push({ type: "IDENT", value: word });
      continue;
    }

    throw new Error(`意外的字符: '${input[i]}' (位置 ${i})`);
  }

  tokens.push({ type: "EOF" });
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private advance(): Token { return this.tokens[this.pos++]; }

  private expect(type: string): Token {
    const t = this.peek();
    if (t.type !== type) throw new Error(`期望 ${type}，得到 ${t.type}`);
    return this.advance();
  }

  parse(): ExprNode {
    const node = this.parseOr();
    if (this.peek().type !== "EOF") {
      throw new Error(`表达式末尾有多余内容`);
    }
    return node;
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();
    while (this.peek().type === "OR") {
      this.advance();
      const right = this.parseAnd();
      left = { type: "or", left, right };
    }
    return left;
  }

  private parseAnd(): ExprNode {
    let left = this.parsePrimary();
    while (this.peek().type === "AND") {
      this.advance();
      const right = this.parsePrimary();
      left = { type: "and", left, right };
    }
    return left;
  }

  private parsePrimary(): ExprNode {
    if (this.peek().type === "LPAREN") {
      this.advance();
      const node = this.parseOr();
      this.expect("RPAREN");
      return node;
    }
    return this.parseComparison();
  }

  private parseComparison(): ExprNode {
    const ident = this.expect("IDENT") as { type: "IDENT"; value: string };
    const op = this.expect("OP") as { type: "OP"; value: ComparisonNode["operator"] };
    if (op.value === "exists") {
      return { type: "comparison", path: ident.value, operator: "exists", value: "" };
    }
    const val = this.expect("STRING") as { type: "STRING"; value: string };
    if (op.value === "matches") {
      if (val.value.length > REGEX_MAX_LENGTH) throw new Error(`正则表达式过长（最大 ${REGEX_MAX_LENGTH} 字符）`);
      try { new RegExp(val.value); } catch { throw new Error(`无效的正则表达式: ${val.value}`); }
    }
    return { type: "comparison", path: ident.value, operator: op.value, value: val.value };
  }
}

export function parseClaimExpr(expr: string): ExprNode {
  if (!expr.trim()) throw new Error("表达式不能为空");
  return new Parser(tokenize(expr)).parse();
}

function resolvePath(obj: unknown, path: string): string[] {
  const segments = path.split(".");
  let current: unknown[] = [obj];

  for (const seg of segments) {
    const next: unknown[] = [];
    for (const item of current) {
      if (item === null || item === undefined) continue;
      if (Array.isArray(item)) {
        for (const el of item) {
          if (el !== null && el !== undefined && typeof el === "object") {
            const val = (el as Record<string, unknown>)[seg];
            if (val !== undefined) next.push(val);
          }
        }
      } else if (typeof item === "object") {
        const val = (item as Record<string, unknown>)[seg];
        if (val !== undefined) next.push(val);
      }
    }
    current = next;
  }

  const result: string[] = [];
  const flatten = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(flatten);
    else if (v !== null && v !== undefined) result.push(String(v));
  };
  current.forEach(flatten);
  return result;
}

export function evaluateClaimExpr(node: ExprNode, claims: Record<string, unknown>): boolean {
  switch (node.type) {
    case "and":
      return evaluateClaimExpr(node.left, claims) && evaluateClaimExpr(node.right, claims);
    case "or":
      return evaluateClaimExpr(node.left, claims) || evaluateClaimExpr(node.right, claims);
    case "comparison": {
      const values = resolvePath(claims, node.path);
      if (node.operator === "exists") return values.length > 0;
      if (values.length === 0) return false;
      switch (node.operator) {
        case "==":
          return values.some((v) => v === node.value);
        case "!=":
          return values.every((v) => v !== node.value);
        case "contains":
          return values.some((v) => v === node.value);
        case "matches": {
          let re: RegExp;
          try { re = new RegExp(node.value); } catch { return false; }
          return values.some((v) => {
            try {
              return safeRegexTest(re, v);
            } catch {
              return false;
            }
          });
        }
        default:
          return false;
      }
    }
  }
}

export function validateClaimExpr(expr: string): { valid: true } | { valid: false; error: string } {
  try {
    parseClaimExpr(expr);
    return { valid: true };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : "表达式语法错误" };
  }
}
