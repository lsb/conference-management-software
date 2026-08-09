// The command line.
//
// Every command calls the same core functions the web handlers call, so there is
// one implementation of "accept a submission" and not two that drift apart.
//
// Output is a readable table by default and JSON with --json, because the two
// audiences are a person squinting at a terminal and something parsing it.

import { openDatabase, DEFAULT_DB_PATH } from './db.js';
import { decide, notify, awaitingNotification, participantsOf } from './core/submissions.js';
import { outstandingTasks, runReminders, taskDefinitions } from './core/tasks.js';
import { findConflicts, scheduledSessions, unscheduledSessions, localTime, localDay } from './core/schedule.js';
import { createMagicLink } from './core/auth.js';
import { queueEmail } from './core/mail.js';
import { audienceSizes, resolveAudience } from './core/audience.js';
import { STATUSES } from './core/submissions.js';

const USAGE = `conf - run a conference from the command line

Usage:
  conf events                            list events
  conf status <event>                    what needs attention
  conf submissions <event> [options]     list submissions
  conf show <event> <CODE>               one submission in full
  conf accept <event> <CODE>...          record an acceptance (sends nothing)
  conf decline <event> <CODE>...         record a decline (sends nothing)
  conf undecide <event> <CODE>...        move back to pending
  conf pending <event>                   decided but not yet told
  conf notify <event> <CODE>...          email those speakers their decision
              [--all] [--dry-run]        --all means every queued decision

  conf sessions <event> [--q text]       what the public can actually attend
  conf agenda <event>                    the schedule, with speakers
  conf conflicts <event>                 clashes in the schedule
  conf speakers <event>                  accepted speakers and what they owe
  conf reviews <event>                   per reviewer: submitted and still to do

  conf tasks <event> [--task SLUG]       outstanding speaker tasks
                     [--person SLUG]     e.g. --task headshot to see who owes one
  conf remind <event> [--dry-run]        chase overdue tasks

  conf audiences <event>                 named groups a message can go to
  conf mail <event> --audience KEY       one message to a group
              [--task SLUG] [--dry-run]
              --subject "..." --body "..."
  conf outbox <event> [--limit N]        messages this app has generated

  conf portal-link <event> <person-slug> a one-time sign-in link for a speaker

Options:
  --status <s>   pending | accept_queue | decline_queue | accepted | declined | withdrawn | draft
  --q <text>     search titles and abstracts
  --json         machine-readable output
  --db <path>    a different database file (default: data/conference.db)

An unrecognised flag is an error, not something to ignore.

Two things that look similar and are not:

  'notify' announces a decision -- accepted or rejected -- and is irreversible.
  It refuses to run without either explicit codes or --all.

  'mail' sends an ordinary message to a named group. That is what you want for
  a deadline change or a reminder about paperwork. Start with 'conf audiences'.

Recording a decision and telling the speaker are also separate on purpose:
'accept' moves a submission into a queue and sends nothing.
`;

/** Flags every command accepts. */
const GLOBAL_FLAGS = ['json', 'db', 'help'];

/**
 * Flags each command accepts, and nothing else.
 *
 * An unrecognised flag is refused rather than ignored. This is not pedantry: a
 * local model once typed `conf notify <event> ---dry-run` -- three dashes -- and
 * the flag was silently dropped, so a command it believed was a preview sent
 * every queued acceptance and rejection for real. A flag you cannot see is worse
 * than no flag at all.
 */
const COMMAND_FLAGS = {
  events: [],
  status: [],
  submissions: ['status', 'q'],
  sessions: ['q'],
  show: [],
  accept: [],
  decline: [],
  undecide: [],
  pending: [],
  notify: ['dry-run', 'all'],
  agenda: [],
  conflicts: [],
  speakers: [],
  reviews: [],
  tasks: ['task', 'person'],
  remind: ['dry-run'],
  mail: ['audience', 'task', 'subject', 'body', 'dry-run'],
  audiences: [],
  outbox: ['limit'],
  'portal-link': [],
};

export function run(argv) {
  const args = parseArgs(argv);
  const command = args._[0];

  if (!command || args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    fail(`unknown command '${command}'`, `run 'conf --help' for the list`);
    return 64;
  }

  const allowed = new Set([...GLOBAL_FLAGS, ...(COMMAND_FLAGS[command] ?? [])]);
  const unknown = Object.keys(args).filter((k) => k !== '_' && !allowed.has(k));
  if (unknown.length > 0) {
    const accepted = (COMMAND_FLAGS[command] ?? []).map((f) => `--${f}`);
    fail(`'${command}' does not take ${unknown.map((f) => `--${f}`).join(', ')}`,
      accepted.length
        ? `it accepts ${accepted.join(', ')}, plus --json and --db`
        : 'it takes no flags beyond --json and --db');
    return 64;
  }

  const db = openDatabase(args.db ?? DEFAULT_DB_PATH);

  try {
    return handler(db, args) ?? 0;
  } catch (err) {
    fail(err.message, err.hint);
    return 1;
  } finally {
    db.close();
  }
}

// --- commands --------------------------------------------------------------

const COMMANDS = {
  events(db, args) {
    const rows = db.prepare('SELECT * FROM event ORDER BY starts_at DESC').all();
    return output(args, rows.map((e) => ({
      slug: e.slug, name: e.name, starts: e.starts_at?.slice(0, 10) ?? '', location: e.location,
    })), 'No events. Run `npm run seed` for a demo conference.');
  },

  status(db, args) {
    const event = requireEvent(db, args._[1]);
    const counts = Object.fromEntries(
      db.prepare('SELECT status, count(*) AS n FROM submission WHERE event_id = ? GROUP BY status')
        .all(event.id).map((r) => [r.status, r.n]),
    );
    const conflicts = findConflicts(db, event.id);
    const summary = {
      event: event.slug,
      name: event.name,
      submissions: counts,
      awaiting_decision: counts.pending ?? 0,
      awaiting_notification: awaitingNotification(db, event.id).length,
      unscheduled: unscheduledSessions(db, event.id).length,
      conflicts: conflicts.filter((c) => c.severity === 'error').length,
      outstanding_tasks: outstandingTasks(db, event.id).length,
    };

    if (args.json) return output(args, summary);

    console.log(`${event.name}  (${event.slug})`);
    console.log(`  ${summary.awaiting_decision} awaiting a decision`);
    console.log(`  ${summary.awaiting_notification} decided but not yet told`);
    console.log(`  ${summary.unscheduled} without a time slot`);
    console.log(`  ${summary.conflicts} scheduling conflicts`);
    console.log(`  ${summary.outstanding_tasks} outstanding speaker tasks`);
    return 0;
  },

  submissions(db, args) {
    const event = requireEvent(db, args._[1]);
    const where = ['s.event_id = ?'];
    const params = [event.id];

    if (args.status) {
      // Validated, and the real vocabulary named. An invented filter used to
      // come back as a confident empty list, which reads exactly like "there
      // are none" and is how a wrong answer gets believed.
      if (!STATUSES.includes(args.status)) {
        throw withHint(new Error(`'${args.status}' is not a submission status`),
          `use one of: ${STATUSES.join(', ')}`);
      }
      where.push('s.status = ?');
      params.push(args.status);
    }
    if (args.q) { where.push('(s.title LIKE ? OR s.description LIKE ?)'); params.push(`%${args.q}%`, `%${args.q}%`); }

    const rows = db.prepare(
      `SELECT s.code, s.status, s.title, t.name AS track,
              (SELECT group_concat(p.first_name || ' ' || p.last_name, ', ')
                 FROM submission_participant sp JOIN person p ON p.id = sp.person_id
                WHERE sp.submission_id = s.id) AS speakers
         FROM submission s LEFT JOIN track t ON t.id = s.track_id
        WHERE ${where.join(' AND ')} ORDER BY s.code`,
    ).all(...params);

    return output(args, rows, 'No submissions match.', 'submission');
  },

  show(db, args) {
    const event = requireEvent(db, args._[1]);
    const submission = requireSubmission(db, event, args._[2]);
    const people = participantsOf(db, submission.id);

    const detail = {
      code: submission.code,
      title: submission.title,
      status: submission.status,
      description: submission.description,
      speakers: people.map((p) => `${p.first_name} ${p.last_name} <${p.email}>`),
      decided_at: submission.decided_at,
      notified_at: submission.notified_at,
      starts_at: submission.starts_at,
      ends_at: submission.ends_at,
    };

    if (args.json) return output(args, detail);

    console.log(`${submission.code}  ${submission.title}`);
    console.log(`status: ${submission.status}`
      + `${submission.notified_at ? ` (speaker told ${submission.notified_at})` : ' (speaker not told)'}`);
    console.log(`speakers: ${detail.speakers.join('; ') || 'none'}`);
    if (submission.starts_at) console.log(`scheduled: ${submission.starts_at} - ${submission.ends_at}`);
    console.log(`\n${submission.description || '(no description)'}`);
    return 0;
  },

  accept: (db, args) => recordDecision(db, args, 'accept'),
  decline: (db, args) => recordDecision(db, args, 'decline'),
  undecide: (db, args) => recordDecision(db, args, 'undecide'),

  pending(db, args) {
    const event = requireEvent(db, args._[1]);
    const rows = awaitingNotification(db, event.id).map((s) => ({
      code: s.code, decision: s.status === 'accept_queue' ? 'accept' : 'decline', title: s.title,
    }));
    return output(args, rows, 'Nothing is waiting to be sent.', 'submission');
  },

  notify(db, args) {
    const event = requireEvent(db, args._[1]);
    const codes = args._.slice(2);
    const queued = awaitingNotification(db, event.id);

    // Refusing to default to "everyone" is the point. This command sends
    // irreversible acceptances and rejections, and the person running it should
    // have had to name who, or say --all out loud.
    if (codes.length === 0 && !args.all) {
      if (queued.length === 0) {
        console.log('Nothing is waiting to be sent.');
        return 0;
      }
      fail(`this would email ${queued.length} decision(s), and you did not say which`,
        `name the codes (conf notify ${event.slug} ${queued.slice(0, 2).map((s) => s.code).join(' ')}), `
        + `or pass --all. Add --dry-run to see it first.`);
      return 64;
    }

    const targets = codes.length > 0
      ? codes.map((code) => requireSubmission(db, event, code))
      : queued;

    if (targets.length === 0) {
      console.log('Nothing is waiting to be sent.');
      return 0;
    }

    if (args['dry-run']) {
      const preview = targets.map((s) => ({
        code: s.code,
        decision: s.status === 'accept_queue' ? 'accept' : s.status === 'decline_queue' ? 'decline' : '-',
        recipients: participantsOf(db, s.id).map((p) => p.email).join(', ') || '(nobody attached)',
        title: s.title,
      }));
      if (args.json) return output(args, { dry_run: true, would_send: preview });

      output(args, preview, 'Nothing would be sent.');
      console.log(`\n${preview.length} email(s) would be sent. Nothing has been sent.`);
      return 0;
    }

    const report = notify(db, targets.map((s) => s.id), {
      portalUrlFor: (person) =>
        `http://127.0.0.1:8080/portal/${event.slug}/enter?token=${createMagicLink(db, person.id, event.id)}`,
    });

    if (args.json) return output(args, report);

    for (const r of report) {
      console.log(r.skipped
        ? `skipped ${r.code ?? r.id}: ${r.skipped}`
        : `${r.code}: told ${r.notified} speaker(s), now ${r.status}`
          + `${r.tasksAssigned ? `, ${r.tasksAssigned} task(s) assigned` : ''}`);
    }
    console.log(`\n${report.filter((r) => !r.skipped).length} sent, `
      + `${report.filter((r) => r.skipped).length} skipped. Messages are in the outbox.`);
    return 0;
  },

  agenda(db, args) {
    const event = requireEvent(db, args._[1]);
    const speakersOf = db.prepare(
      `SELECT group_concat(p.first_name || ' ' || p.last_name, ', ') AS names
         FROM submission_participant sp JOIN person p ON p.id = sp.person_id
        WHERE sp.submission_id = ?`,
    );
    const rows = scheduledSessions(db, event.id).map((s) => ({
      code: s.code,
      day: localDay(s.starts_at, event.timezone),
      time: `${localTime(s.starts_at, event.timezone)}-${localTime(s.ends_at, event.timezone)}`,
      room: s.room_name ?? '',
      title: s.title,
      speakers: speakersOf.get(s.id).names ?? '',
    }));

    if (args.json) {
      return output(args, { scheduled: rows, unscheduled: unscheduledSessions(db, event.id) });
    }

    output(args, rows, 'Nothing is scheduled yet.');
    const missing = unscheduledSessions(db, event.id);
    if (missing.length > 0) {
      console.log(`\n${missing.length} session(s) still need a slot: `
        + missing.map((s) => s.code).join(', '));
    }
    return 0;
  },

  conflicts(db, args) {
    const event = requireEvent(db, args._[1]);
    const conflicts = findConflicts(db, event.id);
    if (args.json) return output(args, conflicts);

    if (conflicts.length === 0) {
      console.log('No conflicts.');
      return 0;
    }
    for (const c of conflicts) {
      console.log(`${c.severity.toUpperCase().padEnd(7)} ${c.sessions.join(' + ').padEnd(16)} ${c.detail}`);
    }
    return conflicts.some((c) => c.severity === 'error') ? 1 : 0;
  },

  speakers(db, args) {
    const event = requireEvent(db, args._[1]);
    const rows = db.prepare(
      `SELECT p.slug, p.first_name || ' ' || p.last_name AS name, p.email,
              p.job_title, p.company,
              group_concat(DISTINCT s.code) AS sessions,
              (p.biography != '') AS bio,
              (SELECT count(*) FROM task_instance ti JOIN task_definition td ON td.id = ti.definition_id
                WHERE ti.person_id = p.id AND td.event_id = ? AND ti.status = 'todo') AS owes
         FROM person p
         JOIN submission_participant sp ON sp.person_id = p.id
         JOIN submission s ON s.id = sp.submission_id
        WHERE s.event_id = ? AND s.status IN ('accept_queue','accepted')
        GROUP BY p.id ORDER BY p.last_name, p.first_name`,
    ).all(event.id, event.id);
    return output(args, rows, 'Nobody has been accepted yet.', 'speaker');
  },

  /**
   * What the public can actually attend.
   *
   * Distinct from `submissions`, which searches everything including drafts and
   * declined proposals. Answering an attendee from that list tells them about a
   * talk that is not happening.
   */
  sessions(db, args) {
    const event = requireEvent(db, args._[1]);
    const rows = db.prepare(
      `SELECT s.code,
              date(s.starts_at) AS day,
              s.title,
              r.name AS room,
              t.name AS track,
              (SELECT group_concat(p.first_name || ' ' || p.last_name, ', ')
                 FROM submission_participant sp JOIN person p ON p.id = sp.person_id
                WHERE sp.submission_id = s.id) AS speakers
         FROM submission s
         LEFT JOIN room r ON r.id = s.room_id
         LEFT JOIN track t ON t.id = s.track_id
        WHERE s.event_id = ? AND s.status = 'accepted'
          AND s.published = 1 AND s.content_status = 'approved'
          AND (? IS NULL OR s.title LIKE '%' || ? || '%' OR s.description LIKE '%' || ? || '%')
        ORDER BY s.starts_at IS NULL, s.starts_at, s.code`,
    ).all(event.id, args.q ?? null, args.q ?? null, args.q ?? null);

    return output(args, rows,
      args.q ? `Nothing published matches '${args.q}'.` : 'Nothing is published yet.',
      'published session');
  },

  /** Who is behind on reviewing, which is the only reason to look. */
  reviews(db, args) {
    const event = requireEvent(db, args._[1]);
    const rows = db.prepare(
      `SELECT p.first_name || ' ' || p.last_name AS reviewer,
              p.email,
              ep.name AS round,
              sum(rv.status = 'submitted') AS submitted,
              sum(rv.status IN ('assigned', 'in_progress')) AS outstanding,
              sum(rv.status = 'declined') AS declined
         FROM review rv
         JOIN person p ON p.id = rv.reviewer_person_id
         JOIN evaluation_plan ep ON ep.id = rv.plan_id
        WHERE ep.event_id = ?
        GROUP BY p.id, ep.id
        ORDER BY outstanding DESC, p.last_name`,
    ).all(event.id);

    return output(args, rows, 'Nobody has been assigned any reviews yet.', 'reviewer');
  },

  /** The named groups a bulk message can go to, and how many people each is. */
  audiences(db, args) {
    const event = requireEvent(db, args._[1]);
    const rows = audienceSizes(db, event.id).map((a) => ({
      audience: a.key, people: a.count, description: a.description,
    }));
    return output(args, rows, 'No audiences.', 'audience');
  },

  /**
   * Send one message to a named group.
   *
   * Separate from `notify`, which announces decisions. Conflating them is how a
   * request to email everyone who owes paperwork turns into an announcement
   * that four people's talks were accepted or rejected.
   */
  mail(db, args) {
    const event = requireEvent(db, args._[1]);
    const key = args.audience;

    if (!key) {
      throw withHint(new Error('which audience?'),
        `conf mail ${event.slug} --audience <key> --subject "..." --body "..."`
        + `\n      see them with: conf audiences ${event.slug}`);
    }

    let recipients;
    try {
      recipients = resolveAudience(db, event.id, key, { taskSlug: args.task ?? null });
    } catch (err) {
      throw withHint(err, err.hint ?? `see them with: conf audiences ${event.slug}`);
    }

    if (recipients.length === 0) {
      console.log(`Nobody is in '${key}' right now, so nothing would be sent.`);
      return 0;
    }

    if (args['dry-run']) {
      const rows = recipients.map((p) => ({ name: fullNameOf(p), email: p.email }));
      if (args.json) return output(args, { dry_run: true, audience: key, recipients: rows });
      output(args, rows);
      console.log(`\n${rows.length} message(s) would be sent to '${key}'. Nothing has been sent.`);
      return 0;
    }

    const subject = args.subject;
    const body = args.body;
    if (!subject || !body) {
      throw withHint(new Error('a message needs a subject and a body'),
        `add --subject "..." --body "...", or use --dry-run to just see the ${recipients.length} recipients`);
    }

    for (const person of recipients) {
      queueEmail(db, {
        eventId: event.id,
        to: person,
        subject,
        body,
        kind: 'bulk',
        vars: {
          event_name: event.name,
          portal_url: `http://127.0.0.1:8080/portal/${event.slug}/enter`
            + `?token=${createMagicLink(db, person.id, event.id)}`,
        },
      });
    }

    if (args.json) return output(args, { audience: key, sent: recipients.length });
    console.log(`Queued ${recipients.length} message(s) to '${key}'. They are in the outbox.`);
    return 0;
  },

  tasks(db, args) {
    const event = requireEvent(db, args._[1]);

    let personId = null;
    if (args.person) {
      const person = db.prepare('SELECT id FROM person WHERE slug = ?').get(args.person);
      if (!person) throw withHint(new Error(`no person with slug '${args.person}'`),
        'list them with `conf speakers <event>`');
      personId = person.id;
    }

    const definitions = taskDefinitions(db, event.id);
    const taskSlug = args.task ?? null;
    if (taskSlug && !definitions.some((d) => d.slug === taskSlug)) {
      throw withHint(new Error(`no task called '${taskSlug}' at this event`),
        `tasks are: ${definitions.map((d) => d.slug).join(', ')}`);
    }

    const rows = outstandingTasks(db, event.id, { personId, taskSlug }).map((t) => ({
      person: `${t.first_name} ${t.last_name}`,
      email: t.email,
      task: t.task_title,
      for: t.submission_code ?? '-',
      due: t.due_at?.slice(0, 10) ?? '-',
    }));

    output(args, rows, 'Everybody is up to date.');

    // Without this, "who owes a headshot" means eyeballing a mixed list and
    // hoping you did not miss a row. Naming the filter is what makes the
    // question answerable in one command.
    if (!args.json && !taskSlug && definitions.length > 1 && rows.length > 0) {
      console.log(`\nFilter to one task with --task <slug>: ${definitions.map((d) => d.slug).join(', ')}`);
    }
    return 0;
  },

  remind(db, args) {
    const event = requireEvent(db, args._[1]);
    const dryRun = Boolean(args['dry-run']);
    const queued = runReminders(db, event.id, {
      dryRun,
      portalUrlFor: (person) =>
        `http://127.0.0.1:8080/portal/${event.slug}/enter?token=${createMagicLink(db, person.id, event.id)}`,
    });

    if (args.json) return output(args, { dry_run: dryRun, reminders: queued });

    if (queued.length === 0) {
      const next = db.prepare(
        `SELECT min(td.due_at) AS due FROM task_instance ti
           JOIN task_definition td ON td.id = ti.definition_id
          WHERE td.event_id = ? AND ti.status = 'todo' AND td.due_at IS NOT NULL`,
      ).get(event.id).due;

      console.log(next
        ? `No reminders are due. The earliest outstanding deadline is ${next.slice(0, 10)}, `
          + 'and speakers are reminded a week before it.'
        : 'No reminders are due. Nothing outstanding has a deadline.');
      console.log(`To send something else, use: conf mail ${event.slug} --audience outstanding-tasks`);
      return 0;
    }
    for (const q of queued) console.log(`${q.email.padEnd(30)} ${q.task}  (${q.rule})`);
    console.log(`\n${queued.length} reminder(s)${dryRun ? ' would be queued (dry run)' : ' queued'}.`);
    return 0;
  },

  outbox(db, args) {
    const event = requireEvent(db, args._[1]);
    const limit = Number(args.limit ?? 25);
    const rows = db.prepare(
      `SELECT created_at, to_email, kind, subject FROM outbox
        WHERE event_id = ? ORDER BY id DESC LIMIT ?`,
    ).all(event.id, limit);
    return output(args, rows, 'No messages yet.', 'message');
  },

  'portal-link'(db, args) {
    const event = requireEvent(db, args._[1]);
    const slug = args._[2];
    if (!slug) throw withHint(new Error('which person?'), 'conf portal-link <event> <person-slug>');
    const person = db.prepare('SELECT * FROM person WHERE slug = ?').get(slug);
    if (!person) throw withHint(new Error(`no person with slug '${slug}'`),
      'list them with `conf speakers <event>`');

    const token = createMagicLink(db, person.id, event.id);
    const url = `http://127.0.0.1:8080/portal/${event.slug}/enter?token=${token}`;
    if (args.json) return output(args, { person: person.slug, url });
    console.log(url);
    return 0;
  },
};

function recordDecision(db, args, decision) {
  const event = requireEvent(db, args._[1]);
  const codes = args._.slice(2);
  if (codes.length === 0) {
    throw withHint(new Error('no submission codes given'),
      `conf ${decision} <event> SESS-1 SESS-2`);
  }

  const submissions = codes.map((code) => requireSubmission(db, event, code));
  decide(db, submissions.map((s) => s.id), decision);

  if (args.json) return output(args, { decision, codes });
  console.log(`${codes.length} submission(s) marked '${decision}'. Nothing has been sent.`);
  if (decision !== 'undecide') {
    console.log(`Run \`conf notify ${event.slug}\` when you are ready to tell the speakers.`);
  }
  return 0;
}

// --- plumbing --------------------------------------------------------------

function requireEvent(db, slug) {
  if (!slug) {
    const known = db.prepare('SELECT slug FROM event ORDER BY starts_at DESC').all().map((e) => e.slug);
    throw withHint(new Error('which event?'),
      known.length ? `try one of: ${known.join(', ')}` : 'no events exist; run `npm run seed`');
  }
  const event = db.prepare('SELECT * FROM event WHERE slug = ?').get(slug);
  if (!event) {
    const known = db.prepare('SELECT slug FROM event').all().map((e) => e.slug);
    throw withHint(new Error(`no event with slug '${slug}'`),
      known.length ? `known events: ${known.join(', ')}` : 'no events exist yet; run `npm run seed`');
  }
  return event;
}

function requireSubmission(db, event, code) {
  if (!code) throw withHint(new Error('which submission?'), 'session codes look like SESS-1');
  const submission = db.prepare('SELECT * FROM submission WHERE event_id = ? AND code = ?')
    .get(event.id, String(code).toUpperCase());
  if (!submission) {
    throw withHint(new Error(`no submission '${code}' in ${event.slug}`),
      `list them with \`conf submissions ${event.slug}\``);
  }
  return submission;
}

function fullNameOf(person) {
  return `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim() || person.email;
}

function withHint(err, hint) {
  err.hint = hint;
  return err;
}

function fail(message, hint) {
  console.error(`error: ${message}`);
  if (hint) console.error(`hint: ${hint}`);
}

/** Print rows as an aligned table, or as JSON when asked. */
function output(args, rows, emptyMessage = 'Nothing to show.', noun = 'row') {
  if (args.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (!Array.isArray(rows)) {
    for (const [key, value] of Object.entries(rows)) {
      console.log(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    }
    return 0;
  }
  if (rows.length === 0) {
    console.log(emptyMessage);
    return 0;
  }

  const columns = Object.keys(rows[0]);
  const width = Object.fromEntries(columns.map((c) => [
    c, Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)),
  ]));
  const line = (cells) => cells.map((cell, i) => String(cell ?? '')
    .padEnd(i === columns.length - 1 ? 0 : width[columns[i]])).join('  ').trimEnd();

  console.log(line(columns.map((c) => c.toUpperCase())));
  for (const row of rows) console.log(line(columns.map((c) => row[c])));

  // State the count rather than leaving it to be worked out. A local model
  // asked how many submissions were pending piped this table to `wc -l` and
  // answered 5: four rows and a header. Nobody should have to count, and the
  // person who does will sometimes get it wrong in the same direction.
  console.log(`\n${rows.length} ${noun}${rows.length === 1 ? '' : 's'}.`);
  return 0;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
      continue;
    }
    args._.push(token);
  }
  return args;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) process.exit(run(process.argv.slice(2)));
