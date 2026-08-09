// Run the local-model usability suite.
//
//   node eval/run-eval.js              every task
//   node eval/run-eval.js <task-id>    just one
//
// A task passes when it succeeds at least 3 times out of 5 attempts.
//
// This used to be "any one of three", which answers a different question. That
// bar asks whether the app is *possible* to use, and it was the right question
// while the answer was often no. Once a feature works, the question that
// matters is whether it works *reliably* -- because a flow that succeeds one
// time in three is one a real organizer will get wrong two evenings out of
// three, and they will not run it five times to see whether they were unlucky.
//
// Attempts stop as soon as the outcome cannot change: three passes, or three
// failures. Each attempt costs a minute or more of CPU inference, so there is
// no point buying an answer we already have.
//
// See docs/EVAL.md for how to write a task and why the rules are what they are.

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(EVAL_DIR);
const TASKS_DIR = join(EVAL_DIR, 'tasks');
const ATTEMPTS = Number(process.env.EVAL_ATTEMPTS ?? 5);
const REQUIRED = Number(process.env.EVAL_REQUIRED ?? 3);

if (REQUIRED > ATTEMPTS) {
  console.error(`cannot require ${REQUIRED} passes out of ${ATTEMPTS} attempts`);
  process.exit(64);
}

const only = process.argv[2] ?? null;

const tasks = existsSync(TASKS_DIR)
  ? readdirSync(TASKS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(TASKS_DIR, d.name, 'prompt.txt')))
      .map((d) => d.name)
      .filter((name) => !only || name === only)
      .sort()
  : [];

if (tasks.length === 0) {
  console.error(only ? `no eval task named '${only}'` : `no eval tasks found in ${TASKS_DIR}`);
  process.exit(1);
}

const startedAt = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
const runDir = join(EVAL_DIR, 'runs', startedAt);
mkdirSync(runDir, { recursive: true });

const results = [];

for (const task of tasks) {
  const taskDir = join(TASKS_DIR, task);
  const prompt = readFileSync(join(taskDir, 'prompt.txt'), 'utf8').trim();
  const setup = join(taskDir, 'setup.sh');
  const check = join(taskDir, 'check.sh');

  process.stdout.write(`\n${task}\n  ${prompt.split('\n')[0]}\n`);

  const attempts = [];
  let passes = 0;
  let failures = 0;

  for (let n = 1; n <= ATTEMPTS; n++) {
    // Stop once the verdict cannot change: enough passes to succeed, or enough
    // failures that the remaining attempts could not reach the bar.
    if (passes >= REQUIRED) break;
    if (failures > ATTEMPTS - REQUIRED) break;

    // Reset state so attempt N cannot coast on work attempt N-1 already did.
    if (existsSync(setup)) {
      const s = spawnSync('bash', [setup], { cwd: ROOT_DIR, encoding: 'utf8' });
      if (s.status !== 0) {
        console.error(`  setup failed: ${s.stderr?.trim()}`);
        break;
      }
    }

    const tracePath = join(runDir, `${task}.attempt-${n}.trace.txt`);
    const began = Date.now();
    const run = spawnSync(join(EVAL_DIR, 'ask-local.sh'), [ROOT_DIR, prompt], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      env: { ...process.env, LOCAL_TRACE: tracePath },
      maxBuffer: 32 * 1024 * 1024,
    });
    const seconds = Math.round((Date.now() - began) / 1000);
    const answer = (run.stdout ?? '').trim();

    let ok = false;
    let detail = '';
    if (run.status !== 0) {
      detail = run.status === 124 ? 'timed out' : `harness exited ${run.status}`;
    } else if (existsSync(check)) {
      const c = spawnSync('bash', [check], { cwd: ROOT_DIR, input: answer, encoding: 'utf8' });
      ok = c.status === 0;
      detail = (c.stdout ?? '').trim() || (c.stderr ?? '').trim();
    } else {
      detail = 'no check.sh; recording answer only';
    }

    attempts.push({ n, ok, seconds, answer, detail });
    writeFileSync(join(runDir, `${task}.attempt-${n}.answer.txt`), `${answer}\n`);

    if (ok) passes++; else failures++;
    process.stdout.write(`  attempt ${n}: ${ok ? 'PASS' : 'fail'} (${seconds}s)`
      + ` [${passes}/${REQUIRED} needed]${detail && !ok ? ` - ${detail}` : ''}\n`);
  }

  const passed = passes >= REQUIRED;
  process.stdout.write(`  => ${passed ? 'PASS' : 'FAIL'}: `
    + `${passes} of ${attempts.length} attempt(s) succeeded, ${REQUIRED} of ${ATTEMPTS} required\n`);

  results.push({ task, passed, passes, attempts, prompt });
}

const passedCount = results.filter((r) => r.passed).length;
const summary = {
  startedAt,
  model: process.env.LOCAL_MODEL ?? 'gemma4:12b-cpu',
  attemptsAllowed: ATTEMPTS,
  passesRequired: REQUIRED,
  passed: passedCount,
  total: results.length,
  results,
};
writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(runDir, 'summary.md'), markdown(summary));

console.log(`\n${REQUIRED}-of-${ATTEMPTS}: ${passedCount}/${results.length} tasks`);
console.log(`details: ${runDir}`);
process.exit(passedCount === results.length ? 0 : 1);

function markdown(s) {
  const lines = [
    `### ${s.startedAt} - \`${s.model}\``,
    '',
    `**${s.passed}/${s.total}** tasks, at ${s.passesRequired} passes out of ${s.attemptsAllowed} attempts`,
    '',
    '| Task | Result | Succeeded | Attempts run | Time |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const r of s.results) {
    const total = r.attempts.reduce((a, b) => a + b.seconds, 0);
    lines.push(`| \`${r.task}\` | ${r.passed ? 'pass' : '**FAIL**'} `
      + `| ${r.passes}/${r.attempts.length} | ${r.attempts.length} | ${total}s |`);
  }

  // Attempts run is reported alongside successes because early stopping makes
  // the two differ: a task that passes three times straight stops at three, and
  // one that fails three times stops there too.
  return `${lines.join('\n')}\n`;
}
