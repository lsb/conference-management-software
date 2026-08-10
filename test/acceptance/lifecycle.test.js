// The conference lifecycle, proved over HTTP alone.
//
// One run creates one event and does everything inside it: configure it, open a
// public call, take a proposal from an anonymous stranger, hand that stranger a
// speaker portal, decide, tell the speaker, schedule, publish, and hand a feed
// to somebody else's website. No other event is touched, read or written.
//
// The steps run in order and share the state one builds for the next, so the
// first failure is the real one and the rest are consequences.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_URL, RUN_ID, Client, disposable, disposableEmail,
  expectStatus, expectRedirect, expectBodyContains, expectBodyLacks,
  expectHeader, expectNoHeader, extract, required, parseOutbox, formFieldNames,
  readableBody, waitForServer, signInAsOrganizer,
} from './helpers.js';

// Events this suite must never write to, whatever else goes wrong.
const SEEDED = new Set(['manzanita-2026', 'manzanita-2025']);

/** The organizer: one identity, one cookie jar, for every back-office call. */
const organizer = new Client('organizer');

/** Everything one step hands to the next. */
const state = {
  event: null,
  form: null,
  room: null,
  track: null,
  talk: null,       // the submission that goes all the way to the public agenda
  spare: null,      // a second submission, for the clash and the notify probe
  speaker: null,
  portalLinkFromSuccessPage: null,
};

describe(`conference lifecycle over HTTP (${BASE_URL})`, () => {
  before(async () => {
    await waitForServer(organizer);

    // Sign in before creating anything: POST /e/new records an owner only when
    // somebody is signed in, and an ownerless event is unmanageable anywhere
    // the app is not bound to loopback.
    state.signIn = await signInAsOrganizer(organizer);
    if (!state.signIn.signedIn) {
      console.log(`\n  not signed in (${state.signIn.how}).`
        + '\n  Fine on loopback, where organizer routes are open to anyone. Anywhere else'
        + '\n  everything after this will 403. See docs/ACCEPTANCE-TESTS.md.');
    }
  });

  after(() => {
    // There is no route that deletes an event, a form, a submission or a
    // person, so this run leaves an event behind on purpose. Say where it is.
    if (state.event) {
      console.log(`\n  acceptance run ${RUN_ID} left one disposable event behind:`
        + `\n    ${BASE_URL}/e/${state.event}`
        + '\n  There is no HTTP route to delete an event. See docs/ACCEPTANCE-TESTS.md.');
    }
  });

  // -------------------------------------------------------------------------
  // 1. An event of our own
  // -------------------------------------------------------------------------

  it('creates its own event, and never borrows a seeded one', async () => {
    const name = disposable('Conf');
    const created = await organizer.postForm('/e/new', {
      name,
      starts_at: '2027-05-12',
      ends_at: '2027-05-13',
      location: 'Nowhere in particular',
      timezone: 'America/Los_Angeles',
      with_defaults: '1',
    });

    const location = expectRedirect(created, { to: '/settings' });
    const slug = extract(created, /\/e\/([^/]+)\/settings/, 'the new event slug', { from: location });

    assert.ok(!SEEDED.has(slug),
      `refusing to continue: POST /e/new handed back the seeded event "${slug}". `
      + 'This suite must only ever work inside an event it created.');
    assert.match(slug, /^acceptance-conf-\d{8}-\d{6}/,
      `expected an obviously disposable, timestamped slug, got "${slug}"`);

    state.event = slug;

    const api = await organizer.get(`/api/events/${slug}`);
    expectStatus(api, 200, 'the event we just created must be readable back over the API');
    assert.equal(api.json().slug, slug);
  });

  it('configures a room and a track', async () => {
    const event = required(state.event, 'an event to configure');

    const room = await organizer.postForm(`/e/${event}/settings/rooms`, {
      name: 'Main Stage', capacity: '200',
    });
    expectRedirect(room, { to: `/e/${event}/settings` });

    const track = await organizer.postForm(`/e/${event}/settings/tracks`, { name: 'Platform' });
    expectRedirect(track, { to: `/e/${event}/settings` });

    const settings = await organizer.get(`/e/${event}/settings`);
    expectStatus(settings, 200);
    expectBodyContains(settings, 'Main Stage', 'the room should be listed on the settings page');
    expectBodyContains(settings, 'Platform', 'the track should be listed on the settings page');

    // The slug is the app's, not ours to guess: read it back off the page.
    state.room = extract(settings, /\/settings\/rooms\/([a-z0-9-]+)\/delete/, 'the room slug');
    state.track = extract(settings, /\/settings\/tracks\/([a-z0-9-]+)\/delete/, 'the track slug');
  });

  // -------------------------------------------------------------------------
  // 2. A public call for speakers
  // -------------------------------------------------------------------------

  it('creates a submission form and opens the public call', async () => {
    const event = required(state.event, 'an event to attach a form to');

    const created = await organizer.postForm(`/e/${event}/forms`, { internal_name: 'Acceptance CFP' });
    const location = expectRedirect(created, { to: '/forms/' });
    state.form = extract(created, /\/forms\/([a-z0-9-]+)$/, 'the new form slug', { from: location });

    const questions = [
      ['Title', 'text', 'abstract', 'submission.title'],
      ['Description', 'textarea', 'abstract', 'submission.description'],
      ['First name', 'text', 'participant', 'person.first_name'],
      ['Last name', 'text', 'participant', 'person.last_name'],
      ['Email', 'email', 'participant', 'person.email'],
    ];
    for (const [label, field_type, section, maps_to] of questions) {
      const field = await organizer.postForm(`/e/${event}/forms/${state.form}/fields`, {
        label, field_type, section, maps_to, required: '1',
      });
      expectRedirect(field, { note: `adding the "${label}" question to the form` });
    }

    // Leave auto_redirect_to_portal off: the customer's must-have is the
    // success page, and with the redirect on nobody ever sees it.
    //
    // `settings_form=1` is what the browser's own settings form sends, and it
    // means "this post carries every checkbox, so the ones I left out are
    // unticked". Without it this is a partial save and the boxes keep whatever
    // they had -- which is deliberate, so that a caller changing one field does
    // not silently switch off the confirmation email.
    const settings = await organizer.postForm(`/e/${event}/forms/${state.form}/settings`, {
      internal_name: 'Acceptance CFP',
      external_title: 'Call for Speakers',
      page_heading: 'Tell us what you would talk about',
      success_message: 'Thank you. We have your proposal.',
      settings_form: '1',
      send_confirmation_email: '1',
      collect_participants: '1',
    });
    expectRedirect(settings);

    const publicPage = await new Client('the public').get(`/submit/${event}/${state.form}`);
    expectStatus(publicPage, 200, 'the call for speakers must be readable by anyone, signed in or not');
    expectBodyContains(publicPage, 'Submissions are open.', 'the call should advertise itself as open');
  });

  it('refuses a proposal to a call that has closed', async () => {
    const event = required(state.event, 'an event to attach a closed form to');

    const created = await organizer.postForm(`/e/${event}/forms`, { internal_name: 'Acceptance CFP Closed' });
    const slug = extract(
      created, /\/forms\/([a-z0-9-]+)$/, 'the closed form slug', { from: expectRedirect(created) },
    );
    await organizer.postForm(`/e/${event}/forms/${slug}/settings`, {
      internal_name: 'Acceptance CFP Closed', close_at: '2020-01-01',
    });
    await organizer.postForm(`/e/${event}/forms/${slug}/fields`, {
      label: 'Title', field_type: 'text', section: 'abstract', maps_to: 'submission.title', required: '1',
    });

    const stranger = new Client('the public');

    const page = await stranger.get(`/submit/${event}/${slug}`);
    expectStatus(page, 200);
    expectBodyContains(page, 'has closed', 'a closed call should say so rather than 404');

    const attempt = await stranger.postForm(`/submit/${event}/${slug}`, { title: 'Too late' });
    expectStatus(attempt, 400, 'a closed call must refuse a proposal, not quietly take it');
    expectBodyContains(attempt, 'closed');
  });

  // -------------------------------------------------------------------------
  // 3. A stranger submits, and is handed a way back in
  // -------------------------------------------------------------------------

  it('takes a proposal from an anonymous member of the public', async () => {
    const event = required(state.event, 'an event');
    const form = required(state.form, 'an open submission form');

    // A brand new client with an empty jar: nobody has signed this person in.
    const stranger = new Client('the public');

    const page = await stranger.get(`/submit/${event}/${form}`);
    expectStatus(page, 200);

    // Fill it in from the HTML, the way a stranger with only a browser must.
    const names = formFieldNames(page, `/submit/${event}/${form}`);
    for (const expected of ['title', 'description', 'first-name', 'last-name', 'email']) {
      assert.ok(names.has(expected),
        `the public form should offer a "${expected}" field; it offers: ${[...names].join(', ')}`);
    }

    state.speaker = {
      first: 'Ada',
      last: `Probe ${RUN_ID}`,
      email: disposableEmail('speaker'),
      title: disposable('Talk'),
    };

    const submitted = await stranger.postForm(`/submit/${event}/${form}`, {
      title: state.speaker.title,
      description: 'A proposal filed by the HTTP acceptance suite. Safe to delete.',
      'first-name': state.speaker.first,
      'last-name': state.speaker.last,
      email: state.speaker.email,
    });

    expectStatus(submitted, 200,
      'with auto_redirect_to_portal off, submitting should render the success page');
    expectBodyContains(submitted, 'Thank you. We have your proposal.');

    // Requirement: the success page hands back a speaker-portal link.
    state.portalLinkFromSuccessPage = extract(
      submitted, /href="(\/portal\/[^"]*enter\?token=[^"]+)"/, 'a speaker portal link on the success page',
    );

    const listed = await organizer.get(`/api/events/${event}/submissions`);
    expectStatus(listed, 200);
    const mine = listed.json().submissions.find((s) => s.title === state.speaker.title);
    assert.ok(mine, `expected the new proposal in ${event}; got ${JSON.stringify(listed.json().submissions)}`);
    assert.equal(mine.status, 'pending', 'a fresh proposal should arrive pending');
    state.talk = mine.code;
  });

  it('emails the submitter a confirmation, and sends nothing outside the app', async () => {
    const event = required(state.event, 'an event');
    const code = required(state.talk, 'a submitted proposal');

    const outbox = await organizer.get(`/api/events/${event}/outbox`);
    expectStatus(outbox, 200);

    const confirmation = outbox.json().messages.find(
      (m) => m.kind === 'submission_confirmation' && m.submission === code,
    );
    assert.ok(confirmation,
      `expected a submission_confirmation for ${code} in the outbox of ${event}; `
      + `found: ${JSON.stringify(outbox.json().messages.map((m) => m.kind))}`);
    assert.equal(confirmation.to, state.speaker.email);

    // Nothing leaves the building: the outbox is the delivery mechanism.
    assert.equal(confirmation.delivered, false,
      'a message in the outbox must not be marked delivered; this suite never sends real email');

    // The body carries the portal link, which is the whole point of the message.
    const page = await organizer.get(`/e/${event}/outbox`);
    expectStatus(page, 200);
    const row = parseOutbox(page).find((m) => m.kind === 'submission_confirmation');
    assert.ok(row, 'expected the confirmation to appear on the HTML outbox page too');

    const message = await organizer.get(`/e/${event}/outbox/${row.id}`);
    expectStatus(message, 200);
    expectBodyContains(message, `/portal/${event}/enter?token=`,
      'the confirmation email must contain a one-time portal link');
    state.portalLinkFromEmail = extract(
      message, /(\/portal\/[^\s<"]*enter\?token=[A-Za-z0-9_-]+)/, 'the portal link inside the email body',
    );
  });

  // This was a defect when this suite was written, and finding it is why the
  // suite exists. POST /submit/:event/:form minted one magic-link token, printed
  // it on the success page, put the same one in the confirmation email -- and
  // then spent it itself, calling consumeMagicLink to sign the submitter in
  // before the response was written. Magic links are single use, so both copies
  // were dead on arrival: every submitter opening that email got "That link no
  // longer works".
  //
  // It was invisible in a browser because the same response sets a session
  // cookie, so nobody testing by hand ever needs the link they were given.
  //
  // Fixed by minting two: one to spend, one to hand over. Only the emailed copy
  // is exercised here, deliberately -- it is the one a submitter still has
  // tomorrow, and probing both would consume a shared token.
  it('the portal link emailed to the submitter actually works', async () => {
    const link = required(state.portalLinkFromEmail, 'a portal link inside the confirmation email');

    // Somebody opening their email on another device: no cookies, only the link.
    const onTheirPhone = new Client('the submitter, on another device');
    const entered = await onTheirPhone.get(link);

    expectRedirect(entered, {
      to: `/portal/${state.event}`,
      note: 'the one-time link in the confirmation email must exchange for a session. '
        + 'This is the "must have" confirmation path: without it a submitter who closes '
        + 'the tab can never reach their proposal again.',
    });
  });

  // -------------------------------------------------------------------------
  // 4. The speaker portal
  // -------------------------------------------------------------------------

  it('lets the speaker in through a one-time link and edits their own profile', async () => {
    const event = required(state.event, 'an event');
    required(state.talk, 'a submitted proposal');

    const speaker = new Client('the speaker');

    const asked = await speaker.postForm('/portal/sign-in', { email: state.speaker.email, event });
    expectRedirect(asked, { to: '/portal/sign-in', note: 'asking for a sign-in link' });

    // The link arrives the only way it ever does: in the outbox.
    const page = await organizer.get(`/e/${event}/outbox`);
    const row = parseOutbox(page).find((m) => m.to === state.speaker.email && /sign-in link/i.test(m.subject));
    assert.ok(row, `expected a sign-in link addressed to ${state.speaker.email} in the outbox`);

    const message = await organizer.get(`/e/${event}/outbox/${row.id}`);
    const token = extract(message, /enter\?token=([A-Za-z0-9_-]+)/, 'the one-time token in the sign-in email');

    const entered = await speaker.get(`/portal/${event}/enter?token=${token}`);
    expectRedirect(entered, { to: `/portal/${event}`, note: 'exchanging the one-time token for a session' });

    const home = await speaker.get(`/portal/${event}`);
    expectStatus(home, 200);
    expectBodyContains(home, state.speaker.title, 'the speaker should see their own proposal');

    // A one-time link is one time.
    const again = await new Client('somebody replaying the link').get(`/portal/${event}/enter?token=${token}`);
    expectStatus(again, 410, 'a sign-in link must not work twice');

    const biography = `Filed by the HTTP acceptance suite, run ${RUN_ID}.`;
    const saved = await speaker.postForm(`/portal/${event}/profile`, {
      first_name: state.speaker.first,
      last_name: state.speaker.last,
      biography,
      job_title: 'Acceptance Probe',
      company: 'Example Invalid',
    });
    expectRedirect(saved, { to: 'saved=1' });

    const profile = await speaker.get(`/portal/${event}/profile`);
    expectBodyContains(profile, biography, 'the speaker\'s own edit should have stuck');

    state.speakerClient = speaker;
  });

  it('shows the speaker their task list', async () => {
    const event = required(state.event, 'an event');
    const speaker = required(state.speakerClient, 'a signed-in speaker');

    const tasks = await speaker.get(`/portal/${event}/tasks`);
    expectStatus(tasks, 200, 'the speaker must be able to see what they owe');

    const api = await organizer.get(`/api/events/${event}/tasks`);
    expectStatus(api, 200);
    assert.ok(Array.isArray(api.json().tasks ?? api.json().outstanding ?? []),
      `expected a list of tasks, got ${readableBody(api, 300)}`);
  });

  // KNOWN GAP, and why this is todo rather than absent.
  //
  // A task only exists if a `task_definition` row does, and the only thing in
  // this codebase that writes one is src/seed.js. No HTTP route and no CLI verb
  // creates one, so an event built entirely over HTTP -- like this one -- can
  // never assign a speaker anything, and the tasks, reminders and file-collection
  // features are unreachable from a fresh event. Nothing here can be fixed by
  // the test; the app needs a route.
  it('a speaker can complete a task they have been set', { todo: 'known gap: no HTTP route creates a task definition, so a new event can never have tasks' }, async () => {
    const event = required(state.event, 'an event');
    const speaker = required(state.speakerClient, 'a signed-in speaker');

    const tasks = await speaker.get(`/portal/${event}/tasks`);
    const id = extract(tasks, /\/tasks\/(\d+)\/complete/, 'a task to complete in the speaker portal');

    const done = await speaker.postForm(`/portal/${event}/tasks/${id}/complete`, {});
    expectRedirect(done, { note: 'marking a task done' });
  });

  // -------------------------------------------------------------------------
  // 5. Deciding, and then -- separately -- telling
  // -------------------------------------------------------------------------

  it('records an acceptance without sending anything', async () => {
    const event = required(state.event, 'an event');
    const code = required(state.talk, 'a proposal to accept');

    const before = (await organizer.get(`/api/events/${event}/outbox`)).json().count;

    const decided = await organizer.postJson(
      `/api/events/${event}/submissions/${code}/decide`, { decision: 'accept' },
    );
    expectStatus(decided, 200);
    assert.equal(decided.json().status, 'accept_queue',
      'accepting should move a proposal into a queue, not finish it');
    assert.equal(decided.json().notified_at, null, 'deciding must not notify');

    const after = (await organizer.get(`/api/events/${event}/outbox`)).json().count;
    assert.equal(after, before,
      `deciding sent ${after - before} message(s). Recording a decision must send nothing: `
      + 'that split is the central safety property of this app.');

    const queue = await organizer.get(`/api/events/${event}/notify`);
    expectStatus(queue, 200);
    assert.ok(queue.json().submissions.some((s) => s.code === code),
      `expected ${code} to be waiting in the notify queue`);
  });

  it('notifies the speaker only when told to, and only in the outbox', async () => {
    const event = required(state.event, 'an event');
    const code = required(state.talk, 'a decided proposal');

    const before = (await organizer.get(`/api/events/${event}/outbox`)).json().count;

    const sent = await organizer.postJson(`/api/events/${event}/notify`, { codes: [code] });
    expectStatus(sent, 200);
    assert.equal(sent.json().notified, 1, `expected exactly one notification, got ${sent.body}`);

    const submission = await organizer.get(`/api/events/${event}/submissions/${code}`);
    assert.equal(submission.json().status, 'accepted', 'notifying should finalise the decision');
    assert.ok(submission.json().notified_at, 'notifying should stamp notified_at');

    const outbox = await organizer.get(`/api/events/${event}/outbox`);
    assert.ok(outbox.json().count > before,
      'notifying must actually queue a message; nothing appeared in the outbox');

    const decision = outbox.json().messages.find((m) => m.kind === 'decision' && m.submission === code);
    assert.ok(decision, `expected a decision message for ${code} in the outbox`);
    assert.equal(decision.to, state.speaker.email);
    assert.equal(decision.delivered, false, 'this suite must never send real email');
  });

  it('refuses to send decisions nobody named, on the organizer form', async () => {
    const event = required(state.event, 'an event');

    // A second proposal, so there is something in the queue worth protecting.
    const stranger = new Client('the public');
    const spareTitle = disposable('Spare Talk');
    await stranger.postForm(`/submit/${event}/${state.form}`, {
      title: spareTitle,
      description: 'A second proposal, filed by the acceptance suite.',
      'first-name': 'Bo',
      'last-name': `Probe ${RUN_ID}`,
      email: disposableEmail('spare'),
    });

    const listed = await organizer.get(`/api/events/${event}/submissions`);
    state.spare = listed.json().submissions.find((s) => s.title === spareTitle)?.code;
    required(state.spare, 'a second proposal');

    await organizer.postJson(
      `/api/events/${event}/submissions/${state.spare}/decide`, { decision: 'accept' },
    );

    const before = (await organizer.get(`/api/events/${event}/outbox`)).json().count;

    const blind = await organizer.postForm(`/e/${event}/notify`, {});
    expectStatus(blind, 400,
      'POST /e/:event/notify with nothing selected must refuse rather than send the whole queue');
    expectBodyContains(blind, 'no submissions selected');

    const after = (await organizer.get(`/api/events/${event}/outbox`)).json().count;
    assert.equal(after, before, 'a refused notify must not have sent anything');
  });

  // The same refusal on the JSON route, which is the one with the widest reach:
  // it is what the llms.txt recipe points a script at.
  //
  // Probed inside our own event with exactly one decision queued, so that if the
  // guard is missing the blast radius is one message to one .invalid address.
  // It has been missing before: until "Make the JSON notify refuse to guess",
  // an empty body meant "everybody", which is Run 4's incident with a different
  // verb. A deployment serving a process older than that commit still does it.
  it('refuses to send decisions nobody named, on the JSON route', async () => {
    const event = required(state.event, 'an event');
    const queued = required(state.spare, 'exactly one queued decision, so this probe is cheap');

    const queue = await organizer.get(`/api/events/${event}/notify`);
    assert.deepEqual(queue.json().submissions.map((s) => s.code), [queued],
      'this probe only runs when exactly one decision is queued in our own event');

    const before = (await organizer.get(`/api/events/${event}/outbox`)).json().count;

    const blind = await organizer.postJson(`/api/events/${event}/notify`, {});
    expectStatus(blind, 400,
      'POST /api/events/:event/notify with no codes must refuse, the way the form and the CLI do. '
      + 'If this deployment answered 200 it just mailed its whole decision queue, irreversibly: '
      + 'it is serving a process older than "Make the JSON notify refuse to guess". Restart it.');

    const after = (await organizer.get(`/api/events/${event}/outbox`)).json().count;
    assert.equal(after, before, 'a refused notify must not have sent anything');
  });

  it('sends the whole queue only when asked for all of it, out loud', async () => {
    const event = required(state.event, 'an event');
    const queued = required(state.spare, 'a queued decision');

    const sent = await organizer.postJson(`/api/events/${event}/notify`, { all: true });
    expectStatus(sent, 200, '{"all":true} is the documented way to mean everybody');
    assert.equal(sent.json().notified, 1, `expected one notification, got ${sent.body}`);

    const submission = await organizer.get(`/api/events/${event}/submissions/${queued}`);
    assert.equal(submission.json().status, 'accepted');

    const drained = await organizer.get(`/api/events/${event}/notify`);
    assert.equal(drained.json().count, 0, 'the queue should be empty once it has been sent');
  });

  // -------------------------------------------------------------------------
  // 6. The schedule
  // -------------------------------------------------------------------------

  it('puts a session in a room, and refuses a slot that clashes', async () => {
    const event = required(state.event, 'an event');
    const code = required(state.talk, 'an accepted session');
    const spare = required(state.spare, 'a second session to collide with');
    const room = required(state.room, 'a room');

    const placed = await organizer.postForm(`/e/${event}/submissions/${code}/schedule`, {
      room, starts_at: '2027-05-12T09:00', ends_at: '2027-05-12T09:45',
    });
    expectRedirect(placed, { to: `/e/${event}/submissions/${code}` });

    const agenda = await organizer.get(`/api/events/${event}/agenda`);
    expectStatus(agenda, 200);
    const slot = agenda.json().scheduled.find((s) => s.code === code);
    assert.ok(slot, `expected ${code} to appear scheduled; got ${readableBody(agenda, 400)}`);
    assert.equal(slot.room, room);

    const clash = await organizer.postForm(`/e/${event}/submissions/${spare}/schedule`, {
      room, starts_at: '2027-05-12T09:30', ends_at: '2027-05-12T10:15',
    });
    expectStatus(clash, 400, 'an overlapping slot in the same room must be refused');
    expectBodyContains(clash, 'clashes');
    expectBodyContains(clash, code, 'the refusal should name what is already in that room');

    const after = await organizer.get(`/api/events/${event}/agenda`);
    assert.ok(!after.json().scheduled.some((s) => s.code === spare),
      'a refused move must not have been applied anyway');
  });

  // -------------------------------------------------------------------------
  // 7. The publish gate: approval AND publication, neither alone
  // -------------------------------------------------------------------------

  it('will not publish a session whose content is not approved', async () => {
    const event = required(state.event, 'an event');
    const code = required(state.talk, 'a scheduled session');

    const published = await organizer.postForm(`/e/${event}/agenda/publish`, {});
    const outcome = decodeURIComponent(expectRedirect(published, { to: '/agenda' }));

    assert.match(outcome, /Published 0 session/,
      `nothing should have been published while content is unapproved; the app said: ${outcome}`);
    assert.match(outcome, /content not approved/,
      `the app should say why it held sessions back; it said: ${outcome}`);

    const agenda = await organizer.get(`/api/events/${event}/agenda`);
    assert.equal(agenda.json().scheduled.find((s) => s.code === code).published, false);

    const publicList = await new Client('the public').get(`/sessions/${event}`);
    expectStatus(publicList, 200);
    expectBodyLacks(publicList, state.speaker.title,
      'an unapproved session must not be on a public surface, scheduled or not');
  });

  it('publishes a session once its content is approved, and shows it publicly', async () => {
    const event = required(state.event, 'an event');
    const code = required(state.talk, 'a scheduled session');

    const approved = await organizer.postForm(`/e/${event}/submissions/${code}/content`, {
      content_status: 'approved',
    });
    expectRedirect(approved, { to: `/e/${event}/submissions/${code}` });

    const published = await organizer.postForm(`/e/${event}/agenda/publish`, {});
    const outcome = decodeURIComponent(expectRedirect(published, { to: '/agenda' }));
    assert.match(outcome, /Published 1 session/,
      `approved and scheduled should now publish; the app said: ${outcome}`);

    const agenda = await organizer.get(`/api/events/${event}/agenda`);
    assert.equal(agenda.json().scheduled.find((s) => s.code === code).published, true);

    const anyone = new Client('the public');

    const list = await anyone.get(`/sessions/${event}`);
    expectStatus(list, 200);
    expectBodyContains(list, state.speaker.title, 'the published session should be on the public session list');

    const grid = await anyone.get(`/agenda/${event}`);
    expectStatus(grid, 200);
    expectBodyContains(grid, state.speaker.title, 'the published session should be on the public agenda grid');

    const submission = await organizer.get(`/api/events/${event}/submissions/${code}`);
    const person = submission.json().speakers[0].slug;
    const speakerPage = await anyone.get(`/speakers/${event}/${person}`);
    expectStatus(speakerPage, 200);
    expectBodyContains(speakerPage, `run ${RUN_ID}`, 'the biography the speaker wrote should be public');
  });

  // -------------------------------------------------------------------------
  // 8. Handing a feed to somebody else's website
  // -------------------------------------------------------------------------

  it('serves a JSON embed cross-origin, and keeps the API agenda private', async () => {
    const event = required(state.event, 'an event');
    const code = required(state.talk, 'a published session');
    const spare = required(state.spare, 'an unpublished session');

    const created = await organizer.postForm(`/e/${event}/embeds`, {
      name: 'Acceptance Programme', feed: 'agenda', format: 'json',
    });
    const embed = extract(
      created, /\/embeds\/([a-z0-9-]+)$/, 'the new embed slug',
      { from: expectRedirect(created, { to: '/embeds/' }) },
    );
    state.embed = embed;

    // Somebody else's website, fetching from their own origin.
    const website = new Client('another website');
    const feed = await website.get(`/embed/${event}/${embed}`, { origin: 'https://example.org' });

    expectStatus(feed, 200);
    expectHeader(feed, 'access-control-allow-origin', '*',
      'an embed is the public, cross-origin feed; without this header it is unusable from another site');
    assert.match(feed.contentType, /json/,
      `an embed created with format=json must serve JSON, got ${feed.contentType}`);

    const body = feed.json();
    assert.ok(JSON.stringify(body).includes(state.speaker.title),
      'the published session should be in the public feed');
    assert.ok(!JSON.stringify(body).includes(spare),
      'an unpublished session must not leak into the public feed');

    // The organizer view is deliberately not a feed.
    const organizerAgenda = await website.get(`/api/events/${event}/agenda`, { origin: 'https://example.org' });
    expectStatus(organizerAgenda, 200);
    expectNoHeader(organizerAgenda, 'access-control-allow-origin',
      '/api/events/:event/agenda is organizer data: it carries unapproved, unannounced sessions '
      + 'and must not be fetchable from another origin');
    assert.ok(organizerAgenda.body.includes(spare),
      'the organizer agenda should include what the public feed hides');
  });

  it('serves an embed in the format the embed records, not the one in the URL', async () => {
    const event = required(state.event, 'an event');

    const created = await organizer.postForm(`/e/${event}/embeds`, {
      name: 'Acceptance Styled', feed: 'agenda', format: 'html',
    });
    const embed = extract(
      created, /\/embeds\/([a-z0-9-]+)$/, 'the html embed slug', { from: expectRedirect(created) },
    );

    const asJson = await new Client('another website').get(`/embed/${event}/${embed}.json`);
    expectStatus(asJson, 200);
    assert.match(asJson.contentType, /html/,
      'the .json extension is cosmetic: an HTML embed stays HTML. To get JSON, create one with format=json.');

    const removed = await organizer.postForm(`/e/${event}/embeds/${embed}/delete`, {});
    expectRedirect(removed, { to: '/embeds' });
    const gone = await new Client('another website').get(`/embed/${event}/${embed}`);
    expectStatus(gone, 404, 'a deleted embed should stop being served');
  });
});
