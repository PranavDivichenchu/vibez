import type { ViClass, ViField, ViMethod } from './types.ts';

/**
 * How classes relate: which class a class extends, every field an object of
 * it carries (its own and its parents'), and which version of a method it
 * runs. Pure functions over the file's `classes` list, used by the ports, the
 * checks, the compiler and the editor alike.
 */

export function findClass(classes: ViClass[] | undefined, name: string): ViClass | undefined {
  return (classes ?? []).find((c) => c.name === name);
}

/** The class and its parents, the class itself first, stopping at a loop or a missing parent. */
export function lineage(classes: ViClass[] | undefined, name: string): ViClass[] {
  const chain: ViClass[] = [];
  const seen = new Set<string>();
  for (let at = findClass(classes, name); at && !seen.has(at.name); at = at.extends ? findClass(classes, at.extends) : undefined) {
    seen.add(at.name);
    chain.push(at);
  }
  return chain;
}

/** Every field an object of this class carries: the oldest parent's first, then each child's. */
export function allFields(classes: ViClass[] | undefined, name: string): ViField[] {
  return lineage(classes, name).reverse().flatMap((c) => c.fields);
}

/** The fields someone must give when making an object: the ones with no starting value. */
export function requiredFields(classes: ViClass[] | undefined, name: string): ViField[] {
  return allFields(classes, name).filter((f) => f.initial === undefined);
}

/** The version of a method an object of this class runs: its own, or the nearest parent's. */
export function findMethod(classes: ViClass[] | undefined, className: string, method: string): { owner: ViClass; method: ViMethod } | undefined {
  for (const c of lineage(classes, className)) {
    const found = c.methods.find((m) => m.name === method);
    if (found) return { owner: c, method: found };
  }
  return undefined;
}

/** The parent's version of a method, for Call Parent inside an override. */
export function parentMethod(classes: ViClass[] | undefined, className: string, method: string): { owner: ViClass; method: ViMethod } | undefined {
  const parent = findClass(classes, className)?.extends;
  return parent ? findMethod(classes, parent, method) : undefined;
}

/** Every method an object of this class can do, with the version it runs. */
export function allMethods(classes: ViClass[] | undefined, className: string): { owner: ViClass; method: ViMethod }[] {
  const out = new Map<string, { owner: ViClass; method: ViMethod }>();
  for (const c of lineage(classes, className)) {
    for (const m of c.methods) if (!out.has(m.name)) out.set(m.name, { owner: c, method: m });
  }
  return [...out.values()];
}

/** Whether `name` is `ancestor` or extends it, however far up. */
export function isSubclassOf(classes: ViClass[] | undefined, name: string, ancestor: string): boolean {
  return lineage(classes, name).some((c) => c.name === ancestor);
}

/** Classes in an order where every parent comes before its children, as the generated code needs. */
export function parentsFirst(classes: ViClass[] | undefined): ViClass[] {
  const list = classes ?? [];
  const placed = new Set<string>();
  const out: ViClass[] = [];
  const place = (c: ViClass, depth: number): void => {
    if (placed.has(c.name) || depth > list.length) return;
    const parent = c.extends ? findClass(list, c.extends) : undefined;
    if (parent) place(parent, depth + 1);
    placed.add(c.name);
    out.push(c);
  };
  for (const c of list) place(c, 0);
  return out;
}

export interface ClassIssue {
  className: string;
  severity: 'error' | 'warning';
  message: string;
}

/** What is wrong with the classes themselves, before any graph uses them. */
export function classIssues(classes: ViClass[] | undefined, otherNames: string[] = []): ClassIssue[] {
  const list = classes ?? [];
  const issues: ClassIssue[] = [];
  const error = (className: string, message: string) => issues.push({ className, severity: 'error', message });
  const names = list.map((c) => c.name);
  for (const c of list) {
    if (names.filter((n) => n === c.name).length > 1) error(c.name, `There are two classes called ${c.name}. Give each class a unique name.`);
    if (otherNames.includes(c.name)) error(c.name, `${c.name} is also the name of a value, action or function. Give the class a different name.`);
    if (!/^[A-Za-z_$][\w$]*$/.test(c.name)) error(c.name, `A class name is one word of letters and digits, like Dog or ShoppingCart; "${c.name}" is not.`);
    if (c.extends) {
      if (!findClass(list, c.extends)) error(c.name, `${c.name} extends ${c.extends}, which does not exist.`);
      else if (lineage(list, c.name).length !== chainLength(list, c.name)) error(c.name, `${c.name} ends up extending itself. A class cannot be its own parent, grandparent or further.`);
    }
    const own = c.fields.map((f) => f.name);
    const inherited = allFields(list, c.name).slice(0, -c.fields.length || undefined).map((f) => f.name);
    for (const f of c.fields) {
      if (own.filter((n) => n === f.name).length > 1) error(c.name, `${c.name} has two fields called ${f.name}.`);
      if (c.extends && inherited.includes(f.name)) error(c.name, `${c.name} already gets a field called ${f.name} from ${c.extends}. Use that one, or give this field another name.`);
      if (c.methods.some((m) => m.name === f.name)) error(c.name, `${c.name} has a field and a method both called ${f.name}.`);
    }
    for (const m of c.methods) {
      if (c.methods.filter((x) => x.name === m.name).length > 1) error(c.name, `${c.name} has two methods called ${m.name}.`);
      if (m.name === 'constructor') error(c.name, `A method cannot be called "constructor". Choose another name.`);
      const overridden = parentMethod(list, c.name, m.name);
      if (overridden) {
        const same = overridden.method.inputs.length === m.inputs.length
          && overridden.method.inputs.every((input, i) => input.type === m.inputs[i]?.type)
          && overridden.method.returns === m.returns;
        if (!same) issues.push({ className: c.name, severity: 'warning', message: `${c.name}.${m.name} replaces ${overridden.owner.name}.${m.name} but takes or returns different things. Code that expects any ${overridden.owner.name} may call it the old way.` });
      }
    }
  }
  return issues;
}

/** How long the extends chain would be if nothing looped, to tell a loop from a normal chain. */
function chainLength(classes: ViClass[], name: string): number {
  let n = 0;
  let at: ViClass | undefined = findClass(classes, name);
  while (at && n <= classes.length) {
    n += 1;
    at = at.extends ? findClass(classes, at.extends) : undefined;
  }
  return n;
}
