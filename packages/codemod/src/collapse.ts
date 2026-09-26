import type { CallExpression, Expression, ObjectLiteralExpression, SourceFile } from 'typescript';
import { type Edit, fold, freshName, indentAt, lineOf, lineStart, referencedNames } from './edits.ts';
import { findLoopLookup } from './batch.ts';
import type { BranchPlan } from './branches.ts';

/**
 * Ask once for everything a loop used to ask for one at a time.
 *
 *   for (const c of customers) {                  const ids = customers.map((c) => c.id);
 *     const [row] = await query(                  const found = ids.length === 0 ? [] : await query(
 *       'SELECT … WHERE userId = ?', [c.id]);  ->   `SELECT userId, … WHERE userId IN (${…})`, ids);
 *     …                                           const byUserId = new Map();
 *   }                                             for (const { userId, ...row } of found) byUserId.set(…);
 *                                                 for (const c of customers) {
 *                                                   const [row] = byUserId.get(c.id) ?? [];
 *
 * Unlike starting every lookup at once, this depends on the query, so it only
 * rewrites the two shapes it can read with certainty:
 *
 *   - Prisma's findUnique / findFirst on one field, which becomes findMany
 *     with `in`.
 *   - A SQL string in the loop that matches one column (`WHERE col = ?`, or
 *     `= $1` for Postgres), which becomes `IN (…)` or `= ANY($1)`.
 *
 * Each pass still gets exactly what its own query returned, in the same order:
 * the rows are grouped by the column they matched on and handed back per item.
 */

type TS = typeof import('typescript');

const cap = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/** SQL with its string literals blanked out, so a `?` inside quotes is not a placeholder. */
const unquoted = (sql: string): string => sql.replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length));

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out.map((part) => part.trim());
}

const toTemplate = (text: string): string => text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

interface Rewrite {
  /** Statements that go before the loop, without indentation. */
  before: string[];
  /** What replaces `await call(...)` inside the loop. */
  replacement: string;
  how: string;
}

function prismaRewrite(ts: TS, file: SourceFile, call: CallExpression, itemNames: Set<string>, list: string, item: string, scope: string): Rewrite | string | undefined {
  const target = call.expression;
  if (!ts.isPropertyAccessExpression(target) || !['findUnique', 'findFirst'].includes(target.name.text)) return undefined;
  if (!ts.isPropertyAccessExpression(target.expression)) return undefined;
  const model = target.expression.name.text;
  const method = target.name.text;
  const arg = call.arguments[0];
  if (call.arguments.length !== 1 || arg === undefined || !ts.isObjectLiteralExpression(arg)) {
    return `The ${method} call does not take a plain { where } object, so Vibez cannot rewrite it safely.`;
  }
  let where: ObjectLiteralExpression | undefined;
  let select: ObjectLiteralExpression | undefined;
  for (const property of arg.properties) {
    const name = property.name?.getText(file);
    if (name === 'where' && ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) {
      where = property.initializer;
    } else if (name === 'select' && ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) {
      select = property.initializer;
    } else if (name !== 'include') {
      return `The ${method} call uses ${name ?? 'a spread'}, which changes what one combined query would return.`;
    }
  }
  if (where === undefined || where.properties.length !== 1) {
    return 'The lookup matches on more than one field. Vibez only combines lookups by a single field.';
  }
  const only = where.properties[0]!;
  const field = only.name?.getText(file);
  let value: Expression | undefined;
  if (ts.isPropertyAssignment(only)) value = only.initializer;
  else if (ts.isShorthandPropertyAssignment(only)) value = only.name;
  if (field === undefined || value === undefined || ts.isObjectLiteralExpression(value)) {
    return 'The lookup does not match one field against one value.';
  }
  const valueText = value.getText(file);
  if (![...referencedNames(ts, valueText)].some((name) => itemNames.has(name))) {
    return `The lookup does not depend on ${item}, so every pass asks the same thing.`;
  }
  if (select !== undefined && !select.properties.some((p) => p.name?.getText(file) === field)) {
    return `The select leaves out ${field}, which the combined answer needs to hand each row back.`;
  }

  const keys = freshName(scope, [`${field}s`, 'keys']);
  const found = freshName(scope, [`${model}s`, 'found', 'rows']);
  const by = freshName(scope, [`by${cap(field)}`, 'byKey']);
  const whereStart = where.getStart(file) - arg.getStart(file);
  const argText = arg.getText(file);
  const newArg = `${argText.slice(0, whereStart)}{ ${field}: { in: ${keys} } }${argText.slice(whereStart + where.getWidth(file))}`;
  return {
    before: [
      `const ${keys} = ${list}.map((${item}) => ${valueText});`,
      `const ${found} = await ${target.expression.getText(file)}.findMany(${newArg});`,
      `const ${by} = new Map(${found}.map((row) => [row.${field}, row]));`,
    ],
    replacement: `(${by}.get(${valueText}) ?? null)`,
    how: `one findMany`,
  };
}

function sqlRewrite(ts: TS, file: SourceFile, call: CallExpression, itemNames: Set<string>, list: string, item: string, scope: string): Rewrite | string | undefined {
  const [first, second, ...rest] = call.arguments;
  if (first === undefined || !(ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) return undefined;
  const sql = first.text;
  if (!/^\s*SELECT\b/i.test(sql)) return 'Only lookups that read can be combined, and this query changes data.';
  if (second === undefined || !ts.isArrayLiteralExpression(second)) {
    return 'The query parameters are not written out as a list, so Vibez cannot see which one changes per pass.';
  }
  if (second.elements.some((element) => ts.isSpreadElement(element))) {
    return 'The query parameters include a spread, so Vibez cannot see which one changes per pass.';
  }
  const perItem = second.elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => [...referencedNames(ts, element.getText(file))].some((name) => itemNames.has(name)));
  if (perItem.length === 0) return `The query does not depend on ${item}, so every pass asks the same thing.`;
  if (perItem.length > 1) return 'More than one parameter changes per pass. Vibez only combines lookups by a single column.';
  const { element, index } = perItem[0]!;

  const blank = unquoted(sql);
  if (/\b(COUNT|SUM|AVG|MIN|MAX)\s*\(|\bGROUP\s+BY\b/i.test(blank)) {
    return 'The query adds rows up. Combining it would need a GROUP BY, and Vibez will not guess one.';
  }
  const limit = /\s+LIMIT\s+(\d+)\b/i.exec(blank);
  if (limit && limit[1] !== '1') return `The query stops at ${limit[1]} rows, which cannot be split back per ${item}.`;
  if (/\bOFFSET\b/i.test(blank)) return 'The query skips rows with OFFSET, which cannot be split back per item.';

  // Find the placeholder for that parameter, and the column it is matched against.
  const postgres = /\$\d/.test(blank);
  let at = -1;
  let width = 1;
  if (postgres) {
    const match = new RegExp(`\\$${index + 1}(?!\\d)`).exec(blank);
    if (match) { at = match.index; width = match[0].length; }
  } else {
    let seen = -1;
    for (let i = 0; i < blank.length; i++) {
      if (blank[i] === '?' && ++seen === index) { at = i; break; }
    }
  }
  if (at === -1) return 'The query has fewer placeholders than parameters.';
  const lhs = /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)\s*=\s*$/.exec(blank.slice(0, at));
  if (!lhs) return 'The query does not match on a single column, like WHERE id = ?.';
  const columnExpr = lhs[1]!;
  const column = columnExpr.split('.').pop()!;

  // The combined answer needs the matched column to hand rows back.
  const selectMatch = /^\s*SELECT\s+([\s\S]*?)\s+FROM\s/i.exec(blank);
  if (!selectMatch) return 'Vibez could not read which columns the query returns.';
  const columns = splitTopLevel(sql.slice(selectMatch[0].indexOf(selectMatch[1]!), selectMatch[0].indexOf(selectMatch[1]!) + selectMatch[1]!.length));
  const present = columns.some((c) => c === '*' || /\.\*$/.test(c) || c === column || c === columnExpr
    || new RegExp(`\\bAS\\s+${column}$`, 'i').test(c));
  const listStart = selectMatch[0].indexOf(selectMatch[1]!);

  const keys = freshName(scope, [`${column}s`, 'keys']);
  const found = freshName(scope, ['found', 'rows', 'combined']);
  const by = freshName(scope, [`by${cap(column)}`, 'byKey']);

  let newSql = sql;
  // Edit right to left so earlier offsets stay valid.
  if (limit) newSql = newSql.slice(0, limit.index) + newSql.slice(limit.index + limit[0].length);
  const eq = lhs.index + lhs[0].indexOf('=');
  if (postgres) {
    newSql = `${newSql.slice(0, eq)}= ANY(${newSql.slice(at, at + width)})${newSql.slice(at + width)}`;
  } else {
    newSql = `${newSql.slice(0, eq)}IN (\u0000)${newSql.slice(at + width)}`;
  }
  if (!present) {
    const add = columnExpr === column ? column : `${columnExpr} AS ${column}`;
    newSql = `${newSql.slice(0, listStart)}${add}, ${newSql.slice(listStart)}`;
  }
  const sqlText = postgres
    ? `\`${toTemplate(newSql)}\``
    : `\`${toTemplate(newSql).replace('\u0000', `\${${keys}.map(() => '?').join(', ')}`)}\``;
  const params = second.elements.map((e, i) => i === index ? (postgres ? keys : `...${keys}`) : e.getText(file)).join(', ');
  const typeArgs = call.typeArguments && call.typeArguments.length === 1
    ? `<${call.typeArguments[0]!.getText(file)} & { ${column}: unknown }>`
    : call.typeArguments ? `<${call.typeArguments.map((t) => t.getText(file)).join(', ')}>` : '';
  const others = rest.map((arg) => arg.getText(file));
  const argList = [sqlText, `[${params}]`, ...others].join(', ');
  const group = present
    ? `for (const row of ${found}) ${by}.set(row.${column}, [...(${by}.get(row.${column}) ?? []), row]);`
    : `for (const { ${column}, ...row } of ${found}) ${by}.set(${column}, [...(${by}.get(${column}) ?? []), row]);`;

  return {
    before: [
      `const ${keys} = ${list}.map((${item}) => ${element.getText(file)});`,
      `const ${found} = ${keys}.length === 0 ? [] : await ${call.expression.getText(file)}${typeArgs}(${argList});`,
      `const ${by} = new Map();`,
      group,
    ],
    replacement: `(${by}.get(${element.getText(file)}) ?? [])`,
    how: 'one query',
  };
}

export function planOneQuery(ts: TS, source: string, fileName: string, symbol: string, count?: number): BranchPlan {
  const found = findLoopLookup(ts, source, fileName, symbol);
  if (!found.ok) return found;
  const { file, fn, loop, waiting, call, item, itemNames, list } = found;
  const scope = fn.getText(file);

  const rewrite = prismaRewrite(ts, file, call, itemNames, list, item, scope)
    ?? sqlRewrite(ts, file, call, itemNames, list, item, scope);
  if (rewrite === undefined) {
    const callee = call.expression.getText(file);
    return { ok: false, reason: `The query is inside ${callee}, not in the loop. Vibez can only combine a query it can read here.` };
  }
  if (typeof rewrite === 'string') return { ok: false, reason: rewrite };

  const indent = indentAt(source, loop.getStart(file));
  const edits: Edit[] = [
    { start: lineStart(source, loop.getStart(file)), end: lineStart(source, loop.getStart(file)),
      text: rewrite.before.map((line) => `${indent}${line}\n`).join('') },
    { start: waiting.getStart(file), end: waiting.getEnd(), text: rewrite.replacement },
  ];
  const folded = fold(source, edits);
  const how = count !== undefined && count > 1 ? `${count} lookups` : 'The lookups';
  return {
    ok: true,
    ...folded,
    line: lineOf(source, folded.start),
    summary: `${how} in ${symbol} become ${rewrite.how}. Each ${item.startsWith('{') ? 'item' : item} still gets its own rows, in the same order.`,
  };
}
