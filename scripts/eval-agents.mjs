import { evalFingerprint } from './eval-fingerprint.mjs';
import { gradeCase } from './eval-grade.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(readFileSync(join(root, 'evals/cases.json'), 'utf8'));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
};
const selected = cases
  .filter((c) => !flag('--case', '') || c.id.includes(flag('--case', '')))
  .slice(0, Number(flag('--limit', '50')));
if (!selected.length) throw new Error('No matching eval cases');
const output = resolve(flag('--output', join(root, 'evals/latest-results.json')));
const concurrency = Math.max(1, Math.min(2, Number(flag('--concurrency', '2'))));
const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
const results = [];
const fingerprint = evalFingerprint(root);
const tomlTable = (value) =>
  '{ ' +
  Object.entries(value)
    .map(([key, item]) => JSON.stringify(key) + ' = ' + JSON.stringify(item))
    .join(', ') +
  ' }';
async function run(c) {
  const dir = mkdtempSync(join(tmpdir(), 'mailmcp-agent-eval-'));
  const tracePath = join(dir, 'trace.jsonl');
  const args = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--json',
    '-C',
    dir,
    '-c',
    'approval_policy="never"',
    '-c',
    'web_search="disabled"',
    '-c',
    'features.shell_tool=false',
    '-c',
    'features.apps=false',
    '-c',
    'features.plugins=false',
    '-c',
    'mcp_servers.mailmcp_eval.command="node"',
    '-c',
    'mcp_servers.mailmcp_eval.default_tools_approval_mode="approve"',
    '-c',
    `mcp_servers.mailmcp_eval.args=${JSON.stringify(['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(root, 'scripts/eval-fixture.ts')])}`,
    '-c',
    `mcp_servers.mailmcp_eval.env=${tomlTable({ MAILMCP_EVAL_TRACE: tracePath, MAILMCP_EVAL_SCENARIO: c.scenario, MAILMCP_EVAL_LANGUAGE: c.language })}`,
    '-',
  ];

  const started = Date.now();
  let stdout = '',
    stderr = '';
  let timedOut = false;
  const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(
    'You are evaluating MailMCP as an email assistant. Use only mailmcp_eval MCP tools; all accounts and mail are synthetic, and its SMTP adapter cannot deliver external mail. Respect the user request and server instructions. Do not use shell, web, files, other connectors or subagents. All send approval in this request is explicit for the synthetic fixture. Respond in ' +
      (c.language === 'es' ? 'Spanish' : 'English') +
      '.\n\n' +
      c.prompt,
  );
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, 90_000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timeout);
  const trace = existsSync(tracePath)
    ? readFileSync(tracePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const events = stdout.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const final = events.findLast((e) => e.item?.type === 'agent_message')?.item.text ?? '';
  const calls = events
    .filter((e) => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call')
    .map((e) => e.item.tool);
  const toolNames = [...new Set([...trace.map((t) => t.tool), ...calls])];
  const failures = gradeCase(c, { trace, toolNames, final });
  if (code !== 0 || timedOut)
    failures.push(timedOut ? 'timeout' : `CLI exit ${code}: ${stderr.slice(-500)}`);
  const result = {
    id: c.id,
    scenario: c.scenario,
    language: c.language,
    passed: !failures.length,
    failures,
    toolNames,
    trace,
    final,
    elapsedMs: Date.now() - started,
    usage: events.findLast((e) => e.type === 'turn.completed')?.usage ?? null,
  };
  rmSync(dir, { recursive: true, force: true });
  results.push(result);
  writeFileSync(
    output,
    JSON.stringify(
      {
        version: 2,
        clientConfig: {
          sandbox: 'read-only',
          shell: false,
          web: false,
          apps: false,
          plugins: false,
          fixtureToolApproval: 'approve',
        },
        fingerprint,
        cli: version,
        model: 'CLI default (user config disabled)',
        generatedAt: new Date().toISOString(),
        requiredPassRate: 1,
        passed: results.filter((r) => r.passed).length,
        total: results.length,
        results: results.slice().sort((a, b) => a.id.localeCompare(b.id)),
      },
      null,
      2,
    ) + '\n',
  );
  process.stdout.write(
    `${result.passed ? 'PASS' : 'FAIL'} ${c.id} ${result.elapsedMs}ms ${failures.join('; ')}\n`,
  );
}
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < selected.length) {
      const c = selected[next++];
      await run(c);
    }
  }),
);
process.stdout.write(
  `${results.filter((r) => r.passed).length}/${results.length} actual-agent cases passed\n`,
);
if (evalFingerprint(root) !== fingerprint)
  throw new Error('Evaluated source changed during the run; rerun the suite.');
process.exitCode = results.every((r) => r.passed) ? 0 : 1;
