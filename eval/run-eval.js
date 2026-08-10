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
import {
  readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync, renameSync,
  mkdtempSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(EVAL_DIR);
const ATTEMPTS = Number(process.env.EVAL_ATTEMPTS ?? 5);
const REQUIRED = Number(process.env.EVAL_REQUIRED ?? 3);

/**
 * Two suites, asking two different questions.
 *
 * The default suite runs the model in the repository. It has AGENTS.md, it has
 * `bin/conf`, it can read the source. That measures whether somebody who has
 * been handed the project can operate it.
 *
 * `--http` runs it in an EMPTY directory with nothing but a URL and a token, so
 * `GET /llms.txt` and the routes it describes carry the entire load. That is the
 * harder and more honest question, because it is the situation of anybody
 * pointed at a deployment: an evaluator, a contractor, an agent. Nothing about
 * how the app is *packaged* can help it -- only what the app *says*.
 */
const HTTP_MODE = process.argv.includes('--http');
const TASKS_DIR = join(EVAL_DIR, HTTP_MODE ? 'tasks-http' : 'tasks');
const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');

/** How many no-tool-call stalls to absorb per task before calling it a day. */
const MAX_STALLS = Number(process.env.EVAL_MAX_STALLS ?? 3);

if (REQUIRED > ATTEMPTS) {
  console.error(`cannot require ${REQUIRED} passes out of ${ATTEMPTS} attempts`);
  process.exit(64);
}

const only = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? null;

if (HTTP_MODE) {
  const health = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
    `${BASE_URL}/healthz`], { encoding: 'utf8' });
  if (health.stdout?.trim() !== '200') {
    console.error(`no server answering at ${BASE_URL}/healthz (got ${health.stdout?.trim() || 'nothing'}).`);
    console.error('The HTTP suite talks to a running server. Start one: npm start');
    process.exit(1);
  }
}

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
  let stalls = 0;

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

    // In HTTP mode the model works from an empty directory it cannot escape
    // usefully, and everything it is given travels in the prompt: a URL and a
    // token, exactly what a person handed a deployment would have. A fresh
    // token per attempt, so attempt N cannot reuse attempt N-1's.
    let workingDir = ROOT_DIR;
    let filledPrompt = prompt;

    if (HTTP_MODE) {
      // OUTSIDE the repository, and this is the whole point.
      //
      // The first version put it under eval/runs/, which is inside the project
      // -- so opencode walked up, found AGENTS.md, and was told to use
      // `./bin/conf`. An attempt duly ran `./bin/conf accept ...` in an empty
      // directory, then listed it seven times looking for the tree it had just
      // read about, and never made a single HTTP request. The blank slate was
      // never blank; it was the repository with the files hidden.
      workingDir = mkdtempSync(join(tmpdir(), `conf-eval-${task}-`));

      const minted = spawnSync('node', [join(EVAL_DIR, 'mint-token.js')],
        { cwd: ROOT_DIR, encoding: 'utf8' });
      if (minted.status !== 0) {
        console.error(`  could not mint a token: ${minted.stderr?.trim()}`);
        break;
      }
      // The token goes in a FILE beside the model, not only in its prompt.
      //
      // We watched an attempt retype a 43-character base64url secret and get it
      // wrong -- `...LA7fRHpnye0...` came back as `...LA7fHirye0...` -- and then
      // spend fifteen tool calls and its whole budget failing to authenticate.
      // Transcription is not what this measures, and it is not what happens in
      // life either: nobody retypes a bearer token, they point at where it is
      // kept. A file is the realistic setup and the fair one.
      writeFileSync(join(workingDir, '.conf-token'), `${minted.stdout.trim()}\n`, { mode: 0o600 });

      filledPrompt = prompt
        .replaceAll('{{BASE_URL}}', BASE_URL)
        .replaceAll('{{TOKEN}}', minted.stdout.trim());
    }

    const tracePath = join(runDir, `${task}.attempt-${n}.trace.txt`);
    const began = Date.now();
    const run = spawnSync(join(EVAL_DIR, 'ask-local.sh'), [workingDir, filledPrompt], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      env: {
        ...process.env,
        LOCAL_TRACE: tracePath,
        // An HTTP task is several round trips where a `conf` command is one, and
        // on a CPU model the cost is dominated by loading the weights and by
        // prefill, not by thinking. At 420s we watched an attempt spend its
        // whole budget on a cold load and a single `ls`, which measures the
        // machine rather than the app. Overridable, as before.
        LOCAL_TIMEOUT: process.env.LOCAL_TIMEOUT ?? (HTTP_MODE ? '900' : '420'),
      },
      maxBuffer: 32 * 1024 * 1024,
    });
    const seconds = Math.round((Date.now() - began) / 1000);
    const answer = (run.stdout ?? '').trim();

    // Keep what the model left behind next to its trace, then take the scratch
    // directory away: some tasks are scored on a file they were asked to write.
    if (HTTP_MODE) {
      const kept = join(runDir, `${task}.attempt-${n}.cwd`);
      rmSync(kept, { recursive: true, force: true });
      cpSync(workingDir, kept, { recursive: true });
      rmSync(workingDir, { recursive: true, force: true });
    }

    // An attempt that made no tool call at all is a stalled model, not a verdict
    // about the app, and counting it as a failure quietly turns the score into
    // part measurement and part weather. We have watched this repeatedly: 900
    // seconds, 120 bytes of trace, not one request. It is loud rather than
    // silent -- it prints, and it is capped -- because a harness that hides its
    // own flakiness is worse than one that is flaky.
    //
    // Not conditioned on the exit status any more. Run 9 had an attempt exit
    // cleanly in 103 seconds having made no request and said nothing, and it was
    // scored as a failure. Doing nothing is doing nothing however the process
    // ends. Safe for side-effect-scored tasks too: with no tool call there is no
    // side effect either, so this can never excuse real work.
    const trace = existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : '';
    const toolCalls = (trace.match(/^\s*(?:\x1b\[[0-9;]*m)*\s*[$%]/gm) ?? []).length;

    // The harness could not start, which is not a verdict about anything.
    //
    // ask-local.sh exits 75 when another run holds its lock, and a lock left
    // behind by a killed run makes every attempt exit in zero seconds. The stall
    // rule absorbed that: three silent retries per task, then "FAIL: 0 of 0
    // attempts" for all eight, which reads exactly like the app failing when
    // nothing had run at all. Retrying cannot help -- a held lock is a condition
    // of the machine, not of this attempt -- so stop and say so.
    if (run.status === 75 || (seconds < 5 && toolCalls === 0 && run.status !== 0)) {
      console.error(`\n  the harness could not start: ${(run.stderr ?? '').trim() || `exit ${run.status}`}`);
      console.error('  nothing was measured. Fix that and run again.');
      process.exit(70);
    }

    if (toolCalls === 0 && answer === '') {
      stalls++;
      // Keep the evidence. The retry reuses this attempt number and would
      // otherwise write over the very trace that shows the stall, which is the
      // only thing that could later prove these were stalls and not something
      // we talked ourselves out of looking at.
      if (existsSync(tracePath)) renameSync(tracePath, `${tracePath}.stall-${stalls}`);

      process.stdout.write(`  attempt ${n}: STALLED (${seconds}s, no tool calls) - not counted`
        + `${stalls >= MAX_STALLS ? ', giving up on this task' : ', retrying'}\n`);
      if (stalls >= MAX_STALLS) break;
      n--;                       // this attempt did not happen
      continue;
    }

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
    + `${passes} of ${attempts.length} attempt(s) succeeded, ${REQUIRED} of ${ATTEMPTS} required`
    + `${stalls > 0 ? `, ${stalls} stall(s) not counted` : ''}\n`);

  results.push({ task, passed, passes, attempts, prompt, stalls });
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
