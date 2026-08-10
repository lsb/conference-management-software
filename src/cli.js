// The command line.
//
// Every command calls the same core functions the web handlers call, so there is
// one implementation of "accept a submission" and not two that drift apart.
//
// Output is a readable table by default and JSON with --json, because the two
// audiences are a person squinting at a terminal and something parsing it.

import { openDatabase, DEFAULT_DB_PATH, now, uniqueSlug } from './db.js';
import { decide, notify, awaitingNotification, participantsOf } from './core/submissions.js';
import { outstandingTasks, runReminders, taskDefinitions } from './core/tasks.js';
import {
  findConflicts, scheduledSessions, unscheduledSessions, placeSession,
  autoSchedule, localTime, localDay,
} from './core/schedule.js';
import { readStoredFile } from './core/files.js';
import { buildZip } from './core/zip.js';
import { FEEDS, FORMATS, showsPeople } from './core/feeds.js';
import { writeFileSync } from 'node:fs';
import { createMagicLink } from './core/auth.js';
import { queueEmail } from './core/mail.js';
import { audienceSizes, resolveAudience } from './core/audience.js';
import { searchPeople, personHistory, notesOn, tagsOn } from './core/crm.js';
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

  conf people [--q text] [--tag T]       the speaker database, across every event
              [--event SLUG]             who spoke at one particular event
              [--never-spoken]           people we know but have never had on stage
  conf person <person-slug>              one person's whole history, notes, and tags

  conf sessions <event> [--q text]       what the public can actually attend
  conf agenda <event>                    the schedule, with speakers
  conf schedule <event> <CODE>           put one session in a room at a time
              --room SLUG --at "YYYY-MM-DDTHH:MM" [--minutes N]
  conf autoschedule <event>              place everything that has no slot yet
  conf files <event> [--task SLUG]       what speakers have uploaded
              [--zip PATH] [--group speaker|session|flat]
  conf embeds <event>                    feeds of your programme for your own site
              [--create "Name" --feed F --format FMT]
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

What this tool cannot do:

  It reads everything, and it changes decisions, reminders, and messages.
  Publishing, files, embeds and forms live on the web server. Start there:

    curl -s http://127.0.0.1:8080/llms.txt

  If there is no verb below for what you want, read that before reading src/.

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
  people: ['q', 'tag', 'company', 'event', 'never-spoken'],
  person: [],
  submissions: ['status', 'q'],
  sessions: ['q'],
  schedule: ['room', 'at', 'minutes'],
  autoschedule: [],
  files: ['task', 'zip', 'group'],
  embeds: ['create', 'feed', 'format', 'track'],
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
    const close = Object.keys(COMMANDS)
      .filter((name) => name.startsWith(command) || command.startsWith(name)
        || editDistance(name, command) <= 2)
      .slice(0, 3);
    fail(`unknown command '${command}'`,
      close.length ? `did you mean: ${close.join(', ')}?` : `run 'conf --help' for the list`);
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
    console.log(`  ${summary.awaiting_decision} awaiting a decision`
      + (summary.awaiting_decision > 0 ? `  ->  conf submissions ${event.slug} --status pending` : ''));
    console.log(`  ${summary.awaiting_notification} decided but not yet told`
      + (summary.awaiting_notification > 0 ? `  ->  conf notify ${event.slug} --all --dry-run` : ''));
    console.log(`  ${summary.unscheduled} without a time slot`
      + (summary.unscheduled > 0 ? `  ->  conf autoschedule ${event.slug}` : ''));
    console.log(`  ${summary.conflicts} scheduling conflicts`
      + (summary.conflicts > 0 ? `  ->  conf conflicts ${event.slug}` : ''));
    console.log(`  ${summary.outstanding_tasks} outstanding speaker tasks`
      + (summary.outstanding_tasks > 0 ? `  ->  conf tasks ${event.slug}` : ''));
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
              CASE
                WHEN s.status NOT IN ('accepted', 'accept_queue') THEN ''
                WHEN s.starts_at IS NULL OR s.room_id IS NULL THEN 'no slot'
                ELSE date(s.starts_at) || ' ' || r.name
              END AS slot,
              (SELECT group_concat(p.first_name || ' ' || p.last_name, ', ')
                 FROM submission_participant sp JOIN person p ON p.id = sp.person_id
                WHERE sp.submission_id = s.id) AS speakers
         FROM submission s
         LEFT JOIN track t ON t.id = s.track_id
         LEFT JOIN room r ON r.id = s.room_id
        WHERE ${where.join(' AND ')} ORDER BY s.code`,
    ).all(...params);

    output(args, rows, 'No submissions match.', 'submission');

    if (!args.json) {
      const missing = rows.filter((r) => r.slot === 'no slot').length;
      if (missing > 0) {
        console.log(`${missing} accepted session(s) have no slot`
          + `  ->  conf autoschedule ${event.slug}`);
      }
    }
    return 0;
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
      console.log(`  place them all:  conf autoschedule ${event.slug}`);
      console.log(`  or one at a time: conf schedule ${event.slug} ${missing[0].code} `
        + '--room <slug> --at "YYYY-MM-DDTHH:MM"');
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

  /**
   * The speaker database, which spans events rather than belonging to one.
   *
   * Takes no event argument on purpose: "who do we know that we have never
   * invited" is a question a per-event list cannot answer, and that is the
   * whole reason this exists.
   */
  people(db, args) {
    const event = args.event
      ? db.prepare('SELECT id FROM event WHERE slug = ?').get(args.event)
      : null;
    if (args.event && !event) {
      const known = db.prepare('SELECT slug FROM event').all().map((e) => e.slug);
      throw withHint(new Error(`no event '${args.event}'`), `events are: ${known.join(', ')}`);
    }

    const rows = searchPeople(db, {
      query: args.q ?? '',
      tag: args.tag ?? '',
      company: args.company ?? '',
      spokeAtEventId: event?.id ?? null,
      neverSpoken: Boolean(args['never-spoken']),
    }).map((p) => ({
      person: p.slug,
      name: `${p.first_name} ${p.last_name}`.trim(),
      company: p.company,
      spoke_at: p.events_spoken,
      submissions: p.submissions,
      tags: p.tags ?? '',
    }));

    return output(args, rows, 'Nobody matches.', 'person');
  },

  /** Everything we know about one human, across every event. */
  person(db, args) {
    const slug = args._[1];
    if (!slug) {
      throw withHint(new Error('which person?'),
        'conf person <person-slug>, and list them with `conf people`');
    }
    const person = db.prepare('SELECT * FROM person WHERE slug = ?').get(slug);
    if (!person) {
      throw withHint(new Error(`no person '${slug}'`), 'list them with `conf people`');
    }

    const history = personHistory(db, person.id);
    const notes = notesOn(db, person.id);
    const tags = tagsOn(db, person.id);

    if (args.json) {
      return output(args, {
        person: person.slug,
        name: `${person.first_name} ${person.last_name}`.trim(),
        email: person.email,
        job_title: person.job_title,
        company: person.company,
        tags,
        history: history.map((h) => ({ event: h.event_slug, code: h.code, title: h.title, status: h.status })),
        notes: notes.map((n) => n.body),
      });
    }

    console.log(`${person.first_name} ${person.last_name}  <${person.email}>`);
    if (person.job_title || person.company) {
      console.log([person.job_title, person.company].filter(Boolean).join(', '));
    }
    if (tags.length > 0) console.log(`tags: ${tags.join(', ')}`);

    const spokenAt = new Set(history.filter((h) => h.status === 'accepted').map((h) => h.event_slug));
    console.log(`\nspoke at ${spokenAt.size} event(s), ${history.length} submission(s) in total`);
    for (const h of history) {
      console.log(`  ${h.event_slug.padEnd(18)} ${h.code.padEnd(8)} ${h.status.padEnd(14)} ${h.title}`);
    }
    if (notes.length > 0) {
      console.log('\nnotes:');
      for (const n of notes) console.log(`  ${n.created_at}  ${n.body}`);
    }
    return 0;
  },

  /**
   * Put one session in a room at a time.
   *
   * Refuses a clash rather than accepting it, exactly as the web form does, and
   * for a stronger reason than agreeing about what a clash is: both call the
   * same `placeSession`, so there is only one thing to agree with. Moving a talk
   * from here revises the speakers' calendar entries just as the form does.
   */
  schedule(db, args) {
    const event = requireEvent(db, args._[1]);
    const submission = requireSubmission(db, event, args._[2]);

    if (!args.room || !args.at) {
      throw withHint(new Error('a session needs a room and a time'),
        `conf schedule ${event.slug} ${submission.code} --room <slug> --at "2026-10-12T09:00"`
        + `\n      rooms: ${db.prepare('SELECT slug FROM room WHERE event_id = ?').all(event.id).map((r) => r.slug).join(', ') || 'none defined'}`);
    }

    const room = db.prepare('SELECT * FROM room WHERE event_id = ? AND slug = ?')
      .get(event.id, args.room);
    if (!room) {
      const known = db.prepare('SELECT slug FROM room WHERE event_id = ?').all(event.id).map((r) => r.slug);
      throw withHint(new Error(`no room '${args.room}' at this event`),
        known.length ? `rooms are: ${known.join(', ')}` : 'this event has no rooms yet');
    }

    const minutes = Number(args.minutes ?? 45);
    const startsAt = localToInstant(args.at, event.timezone);
    if (!startsAt) {
      throw withHint(new Error(`could not read '${args.at}' as a time`),
        'use YYYY-MM-DDTHH:MM, in the event\'s own timezone');
    }
    const endsAt = new Date(Date.parse(startsAt) + minutes * 60000)
      .toISOString().replace(/\.\d{3}Z$/, 'Z');

    const { clashes, invited } = placeSession(db, event.id, submission.id, {
      roomId: room.id, startsAt, endsAt,
    });

    if (clashes.length > 0) {
      throw withHint(new Error(`that slot clashes: ${clashes.map((c) => c.detail).join('; ')}`),
        'pick another room or time, or move the other session first');
    }

    if (args.json) {
      return output(args, { code: submission.code, room: room.slug, starts_at: startsAt,
        ends_at: endsAt, invited: invited ? invited.messages : 0 });
    }
    console.log(`${submission.code} is now in ${room.name}, ${startsAt} to ${endsAt}.`);
    if (invited) {
      console.log(`Calendar ${invited.sequence === 0 ? 'invite' : 'update'} sent to `
        + `${invited.messages} speaker(s).`);
    }
    console.log('It is not on the public agenda until its content is approved and it is published.');
    return 0;
  },

  /** Place everything that has no slot. A draft to argue with, not a timetable. */
  autoschedule(db, args) {
    const event = requireEvent(db, args._[1]);
    const placed = autoSchedule(db, event.id, {
      toInstant: (value) => localToInstant(value, event.timezone),
    });

    if (args.json) return output(args, { placed });
    if (placed.length === 0) {
      console.log('Nothing could be placed. Either everything has a slot, or there are no rooms.');
      return 0;
    }
    output(args, placed, 'Nothing placed.', 'session');
    const left = unscheduledSessions(db, event.id).length;
    if (left > 0) console.log(`${left} still without a slot.`);
    console.log('Nothing has been published; check it first.');
    return 0;
  },

  /** What speakers have sent in, and optionally all of it in one archive. */
  files(db, args) {
    const event = requireEvent(db, args._[1]);

    if (args.task) {
      const known = taskDefinitions(db, event.id).map((t) => t.slug);
      if (!known.includes(args.task)) {
        throw withHint(new Error(`no task called '${args.task}' at this event`),
          known.length ? `tasks are: ${known.join(', ')}` : 'this event has no tasks');
      }
    }

    const rows = db.prepare(
      `SELECT f.slug, f.filename, f.content_type, f.byte_size, f.created_at,
              p.first_name || ' ' || p.last_name AS uploaded_by,
              td.slug AS task, s.code AS submission
         FROM file f
         LEFT JOIN person p ON p.id = f.uploaded_by_person_id
         LEFT JOIN task_instance ti ON ti.file_id = f.id
         LEFT JOIN task_definition td ON td.id = ti.definition_id
         LEFT JOIN submission s ON s.id = ti.submission_id
        WHERE f.event_id = ? AND f.superseded_at IS NULL
          AND (? IS NULL OR td.slug = ?)
        ORDER BY p.last_name, f.created_at`,
    ).all(event.id, args.task ?? null, args.task ?? null);

    if (!args.zip) {
      return output(args, rows.map((r) => ({
        file: r.slug, filename: r.filename, from: r.uploaded_by ?? '',
        task: r.task ?? '', submission: r.submission ?? '',
        kb: Math.max(1, Math.round(r.byte_size / 1024)),
      })), 'Nothing has been uploaded yet.', 'file');
    }

    const grouping = args.group ?? 'speaker';
    if (!['speaker', 'session', 'flat'].includes(grouping)) {
      throw withHint(new Error(`unknown grouping '${grouping}'`),
        'use --group speaker, --group session, or --group flat');
    }

    const entries = [];
    for (const row of rows) {
      const stored = readStoredFile(db, row.slug);
      if (!stored) continue;
      const folder = grouping === 'speaker' ? (row.uploaded_by ?? 'unknown')
        : grouping === 'session' ? (row.submission ?? 'no session') : '';
      entries.push({ name: folder ? `${folder}/${row.filename}` : row.filename,
        data: stored.data, date: row.created_at });
    }

    if (entries.length === 0) {
      throw withHint(new Error('there are no files to put in an archive'),
        args.task ? `nobody has uploaded anything for '${args.task}'` : 'nothing has been uploaded');
    }

    writeFileSync(args.zip, buildZip(entries));
    if (args.json) return output(args, { wrote: args.zip, files: entries.length });
    console.log(`Wrote ${entries.length} file(s) to ${args.zip}.`);
    return 0;
  },

  /**
   * Feeds of the programme for somebody else's website.
   *
   * Lists them, and creates one. Creating mattered: without it the only way to
   * get a JSON feed was the web form, and "give the website team a JSON feed"
   * is a request that arrives by email, not by clicking.
   */
  embeds(db, args) {
    const event = requireEvent(db, args._[1]);
    const base = 'http://127.0.0.1:8080';

    if (args.create) {
      const feed = args.feed ?? 'agenda';
      const format = args.format ?? 'html';

      if (!FEEDS.some((f) => f.value === feed)) {
        throw withHint(new Error(`no feed called '${feed}'`),
          `feeds are: ${FEEDS.map((f) => f.value).join(', ')}`);
      }
      if (!FORMATS.some((f) => f.value === format)) {
        throw withHint(new Error(`no format called '${format}'`),
          `formats are: ${FORMATS.map((f) => f.value).join(', ')}`);
      }
      if (format === 'ics' && showsPeople(feed)) {
        throw withHint(new Error('a speaker list has nothing to put in a calendar'),
          'choose agenda or session_list for ics, or a different format');
      }

      const track = args.track
        ? db.prepare('SELECT id FROM track WHERE event_id = ? AND slug = ?').get(event.id, args.track)
        : null;
      if (args.track && !track) {
        const known = db.prepare('SELECT slug FROM track WHERE event_id = ?').all(event.id).map((t) => t.slug);
        throw withHint(new Error(`no track '${args.track}'`), `tracks are: ${known.join(', ')}`);
      }

      const name = String(args.create);
      const slug = uniqueSlug(name,
        (candidate) => Boolean(db.prepare('SELECT 1 FROM embed WHERE event_id = ? AND slug = ?')
          .get(event.id, candidate)));

      db.prepare(
        `INSERT INTO embed (event_id, slug, name, feed, format, enabled, filter_track_id, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(event.id, slug, name, feed, format, track?.id ?? null, now());

      const url = `${base}/embed/${event.slug}/${slug}${format === 'html' ? '' : `.${format}`}`;
      if (args.json) return output(args, { embed: slug, feed, format, url });
      console.log(`Created '${name}'.`);
      console.log(`  ${url}`);
      return 0;
    }

    const rows = db.prepare('SELECT * FROM embed WHERE event_id = ? ORDER BY created_at').all(event.id)
      .map((e) => ({
        embed: e.slug,
        shows: e.feed,
        as: e.format,
        enabled: e.enabled ? 'yes' : 'no',
        url: `${base}/embed/${event.slug}/${e.slug}${e.format === 'html' ? '' : `.${e.format}`}`,
      }));

    output(args, rows, 'No embeds yet.', 'embed');
    if (!args.json) {
      console.log(`\nMake one:  conf embeds ${event.slug} --create "Agenda" --feed agenda --format json`);
      console.log(`  feeds:   ${FEEDS.map((f) => f.value).join(', ')}`);
      console.log(`  formats: ${FORMATS.map((f) => f.value).join(', ')}`);
      console.log('  an embed records its own format; the extension on the URL is cosmetic.');
    }
    return 0;
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

/**
 * Read a wall-clock time in the event's timezone as an instant.
 *
 * The same conversion the web form does. Interpreting "09:00" as UTC would shift
 * every session by the event's offset, which is the bug that puts a keynote at
 * two in the morning.
 */
function localToInstant(value, timezone) {
  const text = String(value).trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return null;

  const naive = `${text.slice(0, 16)}:00`;
  const guess = new Date(`${naive}Z`);
  if (Number.isNaN(guess.getTime())) return null;

  const asLocal = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(guess).replace(' ', 'T');

  const offset = guess.getTime() - new Date(`${asLocal}Z`).getTime();
  return new Date(guess.getTime() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * How many single-character edits separate two strings.
 *
 * Only used to turn "unknown command 'embed'" into "did you mean: embeds?".
 * Getting the name nearly right and being sent to a help page is a small
 * cruelty when the answer is one letter away.
 */
function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
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
