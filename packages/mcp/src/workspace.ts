import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, posix, basename } from 'node:path';
import { parseDoc, parseViExports, serialize, type Linked, type UiDoc, type ViExports } from '../../ui/src/index.ts';

/**
 * The project folder an agent is working in, and the only place it may read
 * or write. Every path an agent passes is resolved against the root and
 * refused if it climbs out, so a tool call can never touch the rest of the
 * machine.
 */
export class Workspace {

  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** An absolute path for a workspace-relative one, or an error naming why not. */
  path(relativePath: string): string {
    const absolute = resolve(this.root, relativePath);
    if (absolute !== this.root && !absolute.startsWith(this.root + sep)) {
      throw new VibezError(`${relativePath} is outside the project folder.`);
    }
    return absolute;
  }

  rel(absolute: string): string {
    return relative(this.root, absolute).split(sep).join('/');
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await stat(this.path(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async read(relativePath: string): Promise<string> {
    try {
      return await readFile(this.path(relativePath), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new VibezError(`There is no file at ${relativePath}.`);
      throw error;
    }
  }

  async write(relativePath: string, text: string): Promise<void> {
    const absolute = this.path(relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
  }

  /** Every file with one of these extensions, skipping dependencies and build output. */
  async find(extensions: string[]): Promise<string[]> {
    const out: string[] = [];
    const skip = new Set(['node_modules', 'out', 'dist', 'build', 'coverage', 'vendor', '__pycache__']);
    let budget = 5000;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8 || budget-- <= 0) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // .vibez holds the recorded flows, which are worth finding.
          if (skip.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.vibez')) continue;
          if (entry.name === 'build' && dir.endsWith('.vibez')) continue;
          await walk(join(dir, entry.name), depth + 1);
        } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
          out.push(this.rel(join(dir, entry.name)));
        }
      }
    };
    await walk(this.root, 0);
    return out.sort();
  }

  // ------------------------------------------------------------ pages

  async readPage(relativePath: string): Promise<UiDoc> {
    requireExt(relativePath, '.ui');
    const text = await this.read(relativePath);
    const parsed = parseDoc(text, titleFrom(relativePath));
    if (!parsed.ok) throw new VibezError(`${relativePath}: ${parsed.reason}`);
    return parsed.doc;
  }

  async writePage(relativePath: string, doc: UiDoc): Promise<void> {
    requireExt(relativePath, '.ui');
    await this.write(relativePath, serialize(doc));
  }

  /**
   * What every `.vi` file in the project offers, keyed by the path a page at
   * `pagePath` would use for it. Offering all of them, not only the ones a
   * page already lists, is what lets an agent link a page to a new file.
   */
  async linkedFor(pagePath: string): Promise<Linked> {
    const linked: Linked = new Map();
    const from = posix.dirname(pagePath);
    for (const file of await this.find(['.vi'])) {
      try {
        linked.set(posix.relative(from, file) || basename(file), parseViExports(await this.read(file)));
      } catch {
        // An unreadable .vi file offers nothing; it is reported by vi_read.
      }
    }
    return linked;
  }

  /** The workspace path of a `.vi` file as a page at `pagePath` refers to it. */
  resolveFrom(pagePath: string, reference: string): string {
    return posix.normalize(posix.join(posix.dirname(pagePath), reference));
  }

  async readExports(relativePath: string): Promise<{ exports: ViExports; raw: Record<string, unknown> }> {
    requireExt(relativePath, '.vi');
    const text = await this.read(relativePath);
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      throw new VibezError(`${relativePath} is not valid JSON: ${(error as Error).message}`);
    }
    return { exports: parseViExports(text), raw };
  }
}

/** A refusal meant for the agent: shown as the tool's answer, never as a crash. */
export class VibezError extends Error {}

export function requireExt(path: string, ext: string): void {
  if (!path.endsWith(ext)) throw new VibezError(`${path} is not a ${ext} file.`);
}

export const titleFrom = (path: string): string => {
  const name = basename(path).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
};
