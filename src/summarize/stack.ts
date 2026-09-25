import fs from 'node:fs';
import path from 'node:path';

interface Probe {
  file: string;
  label: string;
  /** Optional dependency names that refine the label. */
  deps?: Array<[string, string]>;
}

const PROBES: Probe[] = [
  {
    file: 'package.json',
    label: 'Node',
    deps: [
      ['typescript', 'TypeScript'],
      ['next', 'Next.js'],
      ['react', 'React'],
      ['vue', 'Vue'],
      ['svelte', 'Svelte'],
      ['express', 'Express'],
      ['fastify', 'Fastify'],
      ['@nestjs/core', 'NestJS'],
      ['vitest', 'Vitest'],
      ['jest', 'Jest'],
      ['playwright', 'Playwright'],
      ['better-sqlite3', 'SQLite'],
      ['prisma', 'Prisma'],
      ['electron', 'Electron'],
      ['react-native', 'React Native'],
      ['tailwindcss', 'Tailwind'],
    ],
  },
  { file: 'tsconfig.json', label: 'TypeScript' },
  { file: 'deno.json', label: 'Deno' },
  { file: 'bun.lockb', label: 'Bun' },
  {
    file: 'pyproject.toml',
    label: 'Python',
    deps: [
      ['fastapi', 'FastAPI'],
      ['django', 'Django'],
      ['flask', 'Flask'],
      ['pandas', 'pandas'],
      ['torch', 'PyTorch'],
      ['pytest', 'pytest'],
    ],
  },
  { file: 'requirements.txt', label: 'Python' },
  { file: 'go.mod', label: 'Go' },
  { file: 'Cargo.toml', label: 'Rust' },
  { file: 'Gemfile', label: 'Ruby' },
  { file: 'composer.json', label: 'PHP' },
  { file: 'pom.xml', label: 'Java' },
  { file: 'build.gradle', label: 'Java' },
  { file: 'build.gradle.kts', label: 'Kotlin' },
  { file: 'pubspec.yaml', label: 'Flutter' },
  { file: 'CMakeLists.txt', label: 'C/C++' },
  { file: 'Dockerfile', label: 'Docker' },
  { file: 'docker-compose.yml', label: 'Docker Compose' },
  { file: '.github/workflows', label: 'GitHub Actions' },
  { file: 'terraform', label: 'Terraform' },
  { file: 'justfile', label: 'just' },
  { file: 'Makefile', label: 'Make' },
];

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export function detectStack(projectPath: string): string[] {
  const found = new Set<string>();
  let packageJson: PackageJsonShape | null = null;
  for (const probe of PROBES) {
    const target = path.join(projectPath, probe.file);
    if (!fs.existsSync(target)) continue;
    found.add(probe.label);
    if (probe.file === 'package.json') {
      try {
        packageJson = JSON.parse(fs.readFileSync(target, 'utf8')) as PackageJsonShape;
      } catch {
        packageJson = null;
      }
    }
  }
  if (packageJson) {
    const deps = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ]);
    for (const [dep, label] of PROBES[0]?.deps ?? []) {
      if (deps.has(dep)) found.add(label);
    }
    const scripts = packageJson.scripts ?? {};
    if (Object.keys(scripts).length > 0) found.add('npm scripts');
  }
  return [...found];
}

/** Detect a conventional test command so briefs can suggest it. */
export function detectTestCommand(projectPath: string): string | null {
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) return 'npm test';
      if (pkg.scripts?.['test:unit']) return 'npm run test:unit';
    } catch {
      // fall through
    }
  }
  if (fs.existsSync(path.join(projectPath, 'pytest.ini')) || fs.existsSync(path.join(projectPath, 'pyproject.toml'))) {
    return 'pytest';
  }
  if (fs.existsSync(path.join(projectPath, 'go.mod'))) return 'go test ./...';
  if (fs.existsSync(path.join(projectPath, 'Cargo.toml'))) return 'cargo test';
  return null;
}
