import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import ts from 'typescript';

// The subpaths the web client imports (`@operator-inbox/core/api` and
// `@operator-inbox/core/keymap`) must never reach node-only code: a value
// import of `node:*`, or of a core module that has one, breaks the Vite bundle
// at runtime rather than at compile time. So walk every RUNTIME import from
// the two entry points, following relative imports through core, and allow
// only the packages below. A type-only import is erased and does not count.
//
// Parsed with the TypeScript AST rather than matched as text, so
// `import { type A, B }` (B is a value) and `import type { A }` are told apart.
//
// Four ways in, each with its own probe below, because a guard with a blind
// spot reports green for a bundle that cannot load:
// - a static import or re-export (`runtimeImports`);
// - a dynamic `import()` — followed when its specifier is a literal, an
//   offender when it is not, since nothing can say where it leads;
// - a node global (`process`, `Buffer`, `require`) read in a walked file,
//   which needs no import at all (`nodeGlobalRefs`);
// - `apps/web/src` importing core's MAIN barrel instead of the two subpaths,
//   which skips the walk entirely (`coreBarrelImports`).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../src');
const WEB_SRC = path.join(HERE, '../../../apps/web/src');
const ENTRIES = ['api/index.ts', 'keymap/index.ts'];
const ALLOWED = [/^effect(\/|$)/];
const WEB_ALLOWED_CORE = [
  '@operator-inbox/core/api',
  '@operator-inbox/core/keymap',
];
const NODE_GLOBALS = new Set(['process', 'Buffer', 'require']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'global', 'self']);

// What stands for a dynamic `import()` whose specifier is not a literal.
const NON_LITERAL = '<non-literal import()>';

const parse = (file: string, text: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);

// Every node of a file, depth first.
const everyNode = (sf: ts.SourceFile, visit: (n: ts.Node) => void): void => {
  const go = (n: ts.Node): void => {
    visit(n);
    ts.forEachChild(n, go);
  };
  go(sf);
};

const isDynamicImport = (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword;

// A dynamic import's specifier, or `NON_LITERAL` when it is computed.
const dynamicSpecifier = (call: ts.CallExpression): string => {
  const arg = call.arguments[0];
  return arg !== undefined && ts.isStringLiteralLike(arg)
    ? arg.text
    : NON_LITERAL;
};

// The runtime module specifiers one file imports or re-exports, statically or
// through `import()`.
const runtimeImports = (file: string, text: string): string[] => {
  const sf = parse(file, text);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const c = st.importClause;
      if (c?.isTypeOnly) continue;
      const named = c?.namedBindings;
      const onlyTypes =
        c !== undefined &&
        c.name === undefined &&
        named !== undefined &&
        ts.isNamedImports(named) &&
        named.elements.length > 0 &&
        named.elements.every((e) => e.isTypeOnly);
      if (onlyTypes) continue;
      out.push((st.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      if (st.isTypeOnly) continue;
      out.push((st.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  everyNode(sf, (n) => {
    if (isDynamicImport(n)) out.push(dynamicSpecifier(n));
  });
  return out;
};

// Is this identifier a NAME (a property, a member, a key) rather than a read
// of a binding? `x.process` and `{ process: 1 }` name no global.
const isNameNotRead = (id: ts.Identifier): boolean => {
  const p = id.parent;
  return (
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    (ts.isPropertyAssignment(p) && p.name === id) ||
    (ts.isPropertySignature(p) && p.name === id) ||
    (ts.isPropertyDeclaration(p) && p.name === id) ||
    (ts.isMethodDeclaration(p) && p.name === id) ||
    (ts.isQualifiedName(p) && p.right === id)
  );
};

// Every read of a node global in one file: a bare `process`, `Buffer` or
// `require`, and the same reached through a global object
// (`globalThis.process`). Conservative: a local binding that happens to share
// the name is reported too, and should be renamed rather than allowed.
const nodeGlobalRefs = (file: string, text: string): string[] => {
  const sf = parse(file, text);
  const out: string[] = [];
  everyNode(sf, (n) => {
    if (ts.isIdentifier(n) && NODE_GLOBALS.has(n.text) && !isNameNotRead(n))
      out.push(n.text);
    else if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      GLOBAL_OBJECTS.has(n.expression.text) &&
      NODE_GLOBALS.has(n.name.text)
    )
      out.push(`${n.expression.text}.${n.name.text}`);
  });
  return out;
};

// Every `@operator-inbox/core…` specifier one web file names — static, type-only,
// re-exported or dynamic, since a type-only import of the main barrel still
// points the client's type checker at node-only modules — that is not one of
// the two browser-safe subpaths.
const coreBarrelImports = (file: string, text: string): string[] => {
  const sf = parse(file, text);
  const specs: string[] = [];
  everyNode(sf, (n) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(n.moduleSpecifier)
    )
      specs.push(n.moduleSpecifier.text);
    else if (isDynamicImport(n)) specs.push(dynamicSpecifier(n));
    else if (
      ts.isImportTypeNode(n) &&
      ts.isLiteralTypeNode(n.argument) &&
      ts.isStringLiteralLike(n.argument.literal)
    )
      specs.push(n.argument.literal.text);
  });
  return specs.filter(
    (s) =>
      (s === '@operator-inbox/core' || s.startsWith('@operator-inbox/core/')) &&
      !WEB_ALLOWED_CORE.includes(s),
  );
};

const resolveLocal = (from: string, spec: string): string => {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [`${base}.ts`, path.join(base, 'index.ts')])
    if (existsSync(c)) return c;
  throw new Error(`cannot resolve ${spec} from ${from}`);
};

interface Walk {
  readonly files: string[];
  // Bare specifier → the file that imports it.
  readonly bare: Map<string, string>;
  // `file: what` for every node global read, and every non-literal import().
  readonly offences: string[];
}

const walk = (): Walk => {
  const seen = new Set<string>();
  const bare = new Map<string, string>();
  const offences: string[] = [];
  const queue = ENTRIES.map((e) => path.join(SRC, e));
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = path.relative(SRC, file);
    const text = readFileSync(file, 'utf8');
    for (const spec of runtimeImports(file, text)) {
      if (spec === NON_LITERAL) offences.push(`${rel}: ${NON_LITERAL}`);
      else if (spec.startsWith('.')) queue.push(resolveLocal(file, spec));
      else bare.set(spec, rel);
    }
    for (const g of nodeGlobalRefs(file, text)) offences.push(`${rel}: ${g}`);
  }
  return { files: [...seen].map((f) => path.relative(SRC, f)), bare, offences };
};

// Every .ts/.tsx file under `dir`, recursively.
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });

describe('the web-facing subpaths are browser-safe', () => {
  it('reach only effect at runtime', () => {
    const { files, bare } = walk();
    // The walk really ran through the contract and the selection rules.
    expect(files).toContain('api/inbox-api.ts');
    expect(files).toContain('keymap/config.ts');
    const offenders = [...bare].filter(
      ([spec]) => !ALLOWED.some((re) => re.test(spec)),
    );
    expect(offenders).toEqual([]);
  });

  it('read no node global and hold no non-literal import()', () => {
    expect(walk().offences).toEqual([]);
  });

  it('are what apps/web imports of core, never the main barrel', () => {
    const files = sourceFiles(WEB_SRC);
    // The scan really ran over the client.
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((f) =>
      coreBarrelImports(f, readFileSync(f, 'utf8')).map(
        (s) => `${path.relative(WEB_SRC, f)}: ${s}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('can see an offender: the probe fires on a value import', () => {
    expect(runtimeImports('x.ts', "import { x } from 'node:path';")).toEqual([
      'node:path',
    ]);
    expect(
      runtimeImports('x.ts', "import { type A, b } from '../inbox';"),
    ).toEqual(['../inbox']);
    expect(
      runtimeImports('x.ts', "import type { A } from '../inbox';"),
    ).toEqual([]);
    expect(
      runtimeImports('x.ts', "import { type A } from '../inbox';"),
    ).toEqual([]);
  });

  it('can see an offender: the probe fires on a dynamic import()', () => {
    expect(
      runtimeImports(
        'x.ts',
        "export const f = async () => (await import('node:fs')).readFileSync;",
      ),
    ).toEqual(['node:fs']);
    expect(
      runtimeImports('x.ts', 'const m = () => import(`../inbox`);'),
    ).toEqual(['../inbox']);
    expect(
      runtimeImports('x.ts', "const n = 'node:fs'; const m = import(n);"),
    ).toEqual([NON_LITERAL]);
  });

  it('can see an offender: the probe fires on a node global', () => {
    expect(nodeGlobalRefs('x.ts', 'const h = process.env.HOME;')).toEqual([
      'process',
    ]);
    expect(nodeGlobalRefs('x.ts', "const b = Buffer.from('x');")).toEqual([
      'Buffer',
    ]);
    expect(nodeGlobalRefs('x.ts', "const p = require('node:path');")).toEqual([
      'require',
    ]);
    expect(
      nodeGlobalRefs('x.ts', 'const e = globalThis.process?.env;'),
    ).toEqual(['globalThis.process']);
    // A property or a key NAMED like a global reads none, and a comment or a
    // string is not code.
    expect(
      nodeGlobalRefs(
        'x.ts',
        "// process\nconst o = { process: 1 }; o.process; const s = 'Buffer';",
      ),
    ).toEqual([]);
  });

  it('can see an offender: the probe fires on the main core barrel', () => {
    expect(
      coreBarrelImports('x.tsx', "import { x } from '@operator-inbox/core';"),
    ).toEqual(['@operator-inbox/core']);
    expect(
      coreBarrelImports(
        'x.tsx',
        "import type { X } from '@operator-inbox/core';",
      ),
    ).toEqual(['@operator-inbox/core']);
    expect(
      coreBarrelImports(
        'x.tsx',
        "export * from '@operator-inbox/core/src/fs';",
      ),
    ).toEqual(['@operator-inbox/core/src/fs']);
    expect(
      coreBarrelImports(
        'x.tsx',
        "const m = () => import('@operator-inbox/core');",
      ),
    ).toEqual(['@operator-inbox/core']);
    expect(
      coreBarrelImports(
        'x.tsx',
        "type T = typeof import('@operator-inbox/core').x;",
      ),
    ).toEqual(['@operator-inbox/core']);
    expect(
      coreBarrelImports(
        'x.tsx',
        "import { a } from '@operator-inbox/core/api';\nimport { b } from '@operator-inbox/core/keymap';\nimport { c } from '@operator-inbox/core-extra';",
      ),
    ).toEqual([]);
  });
});
