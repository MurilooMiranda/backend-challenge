import { join } from 'node:path';

interface Step {
  name: string;
  cmd: string[];
  needsDocker?: boolean;
}

const PROMETHEUS_IMAGE = 'prom/prometheus:v2.53.0';
const observability = join(process.cwd(), 'docker', 'observability');

function promtool(...args: string[]): string[] {
  return [
    'docker',
    'run',
    '--rm',
    '--mount',
    `type=bind,source=${observability},target=/obs,readonly`,
    '--mount',
    `type=bind,source=${join(observability, 'alerts.yml')},target=/etc/prometheus/alerts.yml,readonly`,
    '--workdir',
    '/obs',
    '--entrypoint',
    'promtool',
    PROMETHEUS_IMAGE,
    ...args,
  ];
}

const steps: Step[] = [
  { name: 'Prettier', cmd: ['bunx', 'prettier', '--check', '.'] },
  { name: 'Typecheck', cmd: ['bun', 'run', 'typecheck'] },
  { name: 'Unit tests', cmd: ['bun', 'test', 'test/unit'] },
  {
    name: 'Compose config',
    cmd: ['docker', 'compose', '--profile', 'app', '--profile', 'observability', 'config', '-q'],
    needsDocker: true,
  },
  {
    name: 'Prometheus config',
    cmd: promtool('check', 'config', 'prometheus.yml'),
    needsDocker: true,
  },
  { name: 'Alert rules', cmd: promtool('check', 'rules', 'alerts.yml'), needsDocker: true },
  {
    name: 'Alert rule tests',
    cmd: promtool('test', 'rules', 'alerts.test.yml'),
    needsDocker: true,
  },
  {
    name: 'Postgres and LocalStack',
    cmd: ['docker', 'compose', 'up', '-d', '--wait', 'postgres', 'localstack'],
    needsDocker: true,
  },
  {
    name: 'Integration, concurrency and property tests',
    cmd: ['bun', 'test', 'test/integration', 'test/concurrency'],
    needsDocker: true,
  },
  {
    name: 'Docker image',
    cmd: ['docker', 'build', '-t', 'wagering-app:check', '.'],
    needsDocker: true,
  },
];

const quick = process.argv.includes('--quick');
const selected = steps.filter((step) => !quick || !step.needsDocker);
const results: { name: string; ok: boolean; seconds: number }[] = [];

for (const step of selected) {
  console.log(`\n\x1b[1m▶ ${step.name}\x1b[0m`);
  const startedAt = performance.now();
  const proc = Bun.spawn(step.cmd, { stdout: 'inherit', stderr: 'inherit' });
  const ok = (await proc.exited) === 0;
  results.push({ name: step.name, ok, seconds: (performance.now() - startedAt) / 1000 });
  if (!ok) {
    break;
  }
}

console.log('\n\x1b[1mResumo\x1b[0m');
for (const result of results) {
  const mark = result.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  console.log(`${mark} ${result.name.padEnd(46)} ${result.seconds.toFixed(1)}s`);
}
for (const step of selected.slice(results.length)) {
  console.log(`- ${step.name.padEnd(46)} não executado`);
}
if (quick) {
  console.log('\nModo --quick: etapas que dependem de Docker foram puladas.');
}

process.exit(results.every((result) => result.ok) ? 0 : 1);
