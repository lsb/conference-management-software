// Rendering an embed's data as HTML, JSON, XML, or iCalendar.
//
// One query, four renderings. The conference that wants our markup and the
// conference whose site is built by somebody with their own templates are
// asking for the same information; only one of them wants it in a `<table>`.

import { escapeHtml } from '../http/html.js';
import { buildIcs, uidFor } from './ics.js';
import { localDay, localTime } from './schedule.js';

export const FEEDS = [
  { value: 'agenda', label: 'Agenda', hint: 'Sessions in time order, grouped by day.' },
  { value: 'session_list', label: 'Session list', hint: 'Every published session.' },
  { value: 'schedule_itinerary', label: 'Schedule itinerary', hint: 'Day by day, with speakers.' },
  { value: 'speaker_list', label: 'Speaker list', hint: 'Names, roles, and biographies.' },
  { value: 'speaker_gallery', label: 'Speaker gallery', hint: 'Photographs.' },
];

export const FORMATS = [
  { value: 'html', label: 'Styled HTML', hint: 'Drop into a page or an iframe.', type: 'text/html; charset=utf-8' },
  { value: 'json', label: 'JSON', hint: 'For a site with its own templates.', type: 'application/json; charset=utf-8' },
  { value: 'xml', label: 'XML', hint: 'For systems that still prefer it.', type: 'application/xml; charset=utf-8' },
  { value: 'ics', label: 'iCalendar', hint: 'Subscribable, so a room change reaches people.', type: 'text/calendar; charset=utf-8' },
];

export function showsPeople(feed) {
  return feed === 'speaker_list' || feed === 'speaker_gallery';
}

/** The data behind an embed: either sessions or people, already filtered. */
export function feedData(db, event, embed) {
  const sessions = db.prepare(
    `SELECT s.id, s.code, s.title, s.description, s.starts_at, s.ends_at,
            r.name AS room_name, t.name AS track_name, t.id AS track_id,
            f.label AS format_label
       FROM submission s
       LEFT JOIN room r ON r.id = s.room_id
       LEFT JOIN track t ON t.id = s.track_id
       LEFT JOIN taxonomy_option f ON f.id = s.format_option_id
      WHERE s.event_id = ? AND s.status = 'accepted'
        AND s.published = 1 AND s.content_status = 'approved'
        AND (? IS NULL OR s.track_id = ?)
      ORDER BY s.starts_at IS NULL, s.starts_at, s.code`,
  ).all(event.id, embed.filter_track_id ?? null, embed.filter_track_id ?? null);

  const speakersOf = db.prepare(
    `SELECT p.slug, p.first_name, p.last_name, p.job_title, p.company, p.biography,
            fi.slug AS headshot
       FROM submission_participant sp
       JOIN person p ON p.id = sp.person_id
       LEFT JOIN file fi ON fi.id = p.headshot_file_id
      WHERE sp.submission_id = ? ORDER BY sp.sort_order`,
  );

  const withSpeakers = sessions.map((s) => ({ ...s, speakers: speakersOf.all(s.id) }));

  if (!showsPeople(embed.feed)) return { sessions: withSpeakers };

  const byId = new Map();
  for (const session of withSpeakers) {
    for (const person of session.speakers) {
      if (!byId.has(person.slug)) byId.set(person.slug, { ...person, sessions: [] });
      byId.get(person.slug).sessions.push({
        code: session.code, title: session.title,
        starts_at: session.starts_at, room: session.room_name,
      });
    }
  }
  const people = [...byId.values()].sort((a, b) =>
    `${a.last_name}${a.first_name}`.localeCompare(`${b.last_name}${b.first_name}`));

  return { sessions: withSpeakers, people };
}

/** Render an embed. Returns `{ contentType, body }`. */
export function renderFeed(db, event, embed, { baseUrl = '' } = {}) {
  const data = feedData(db, event, embed);
  const type = FORMATS.find((f) => f.value === embed.format)?.type ?? 'text/plain';

  switch (embed.format) {
    case 'json': return { contentType: type, body: renderJson(event, embed, data) };
    case 'xml': return { contentType: type, body: renderXml(event, embed, data) };
    case 'ics': return { contentType: type, body: renderIcs(event, embed, data) };
    default: return { contentType: type, body: renderHtml(event, embed, data, baseUrl) };
  }
}

// --- JSON ------------------------------------------------------------------

function sessionShape(event, embed, s) {
  return {
    code: s.code,
    title: s.title,
    ...(embed.include_description ? { description: s.description } : {}),
    starts_at: s.starts_at,
    ends_at: s.ends_at,
    ...(embed.include_room ? { room: s.room_name ?? null } : {}),
    track: s.track_name ?? null,
    format: s.format_label ?? null,
    ...(embed.include_speakers
      ? {
          speakers: s.speakers.map((p) => ({
            name: `${p.first_name} ${p.last_name}`.trim(),
            job_title: p.job_title || undefined,
            company: p.company || undefined,
          })),
        }
      : {}),
  };
}

function personShape(embed, p) {
  return {
    name: `${p.first_name} ${p.last_name}`.trim(),
    job_title: p.job_title || undefined,
    company: p.company || undefined,
    ...(embed.include_description ? { biography: p.biography } : {}),
    sessions: p.sessions.map((s) => ({ code: s.code, title: s.title, starts_at: s.starts_at })),
  };
}

function renderJson(event, embed, data) {
  const payload = {
    event: { slug: event.slug, name: event.name, timezone: event.timezone,
      starts_at: event.starts_at, ends_at: event.ends_at },
    feed: embed.feed,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...(showsPeople(embed.feed)
      ? { speakers: data.people.map((p) => personShape(embed, p)) }
      : { sessions: data.sessions.map((s) => sessionShape(event, embed, s)) }),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

// --- XML -------------------------------------------------------------------

/** Escape for XML text and attributes. Same five characters as HTML. */
function xml(value) {
  return escapeHtml(value ?? '');
}

function tag(name, value) {
  return value === null || value === undefined || value === ''
    ? '' : `      <${name}>${xml(value)}</${name}>\n`;
}

function renderXml(event, embed, data) {
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n';
  out += `<feed kind="${xml(embed.feed)}">\n`;
  out += `  <event slug="${xml(event.slug)}" timezone="${xml(event.timezone)}">`
    + `${xml(event.name)}</event>\n`;

  if (showsPeople(embed.feed)) {
    out += '  <speakers>\n';
    for (const p of data.people) {
      out += '    <speaker>\n';
      out += tag('name', `${p.first_name} ${p.last_name}`.trim());
      out += tag('jobTitle', p.job_title);
      out += tag('company', p.company);
      if (embed.include_description) out += tag('biography', p.biography);
      out += '      <sessions>\n';
      for (const s of p.sessions) {
        out += `        <session code="${xml(s.code)}">${xml(s.title)}</session>\n`;
      }
      out += '      </sessions>\n    </speaker>\n';
    }
    out += '  </speakers>\n';
  } else {
    out += '  <sessions>\n';
    for (const s of data.sessions) {
      out += `    <session code="${xml(s.code)}">\n`;
      out += tag('title', s.title);
      if (embed.include_description) out += tag('description', s.description);
      out += tag('startsAt', s.starts_at);
      out += tag('endsAt', s.ends_at);
      if (embed.include_room) out += tag('room', s.room_name);
      out += tag('track', s.track_name);
      out += tag('format', s.format_label);
      if (embed.include_speakers) {
        out += '      <speakers>\n';
        for (const p of s.speakers) {
          out += `        <speaker>${xml(`${p.first_name} ${p.last_name}`.trim())}</speaker>\n`;
        }
        out += '      </speakers>\n';
      }
      out += '    </session>\n';
    }
    out += '  </sessions>\n';
  }

  return `${out}</feed>\n`;
}

// --- iCalendar -------------------------------------------------------------

/**
 * One VCALENDAR holding every session in the feed.
 *
 * Subscribable, which is the point: an attendee who subscribes sees the room
 * change, where somebody who downloaded a file once does not. UIDs match the
 * per-session invites, so a speaker who is also an attendee gets one entry.
 */
function renderIcs(event, embed, data) {
  const scheduled = data.sessions.filter((s) => s.starts_at && s.ends_at);
  if (scheduled.length === 0) {
    return 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//conference management//EN\r\n'
      + `X-WR-CALNAME:${event.name}\r\nEND:VCALENDAR\r\n`;
  }

  const events = scheduled.map((s) => buildIcs({
    uid: uidFor(event.slug, s.code),
    title: s.title,
    description: embed.include_description ? s.description : '',
    location: embed.include_room ? [s.room_name, event.location].filter(Boolean).join(', ') : '',
    startsAt: s.starts_at,
    endsAt: s.ends_at,
    url: event.website_url,
  }));

  const head = events[0].slice(0, events[0].indexOf('BEGIN:VEVENT'));
  const bodies = events.map((ics) =>
    ics.slice(ics.indexOf('BEGIN:VEVENT'), ics.lastIndexOf('END:VCALENDAR'))).join('');

  return `${head}X-WR-CALNAME:${event.name}\r\n${bodies}END:VCALENDAR\r\n`;
}

// --- HTML ------------------------------------------------------------------

/**
 * A standalone fragment with its own styles inlined.
 *
 * Self-contained on purpose: dropping this into an iframe needs no stylesheet,
 * no script, and no request back to us for assets.
 */
function renderHtml(event, embed, data, baseUrl) {
  const accent = embed.accent_color || '#1f52c8';
  const link = (path) => (baseUrl ? `${baseUrl}${path}` : path);

  const style = `
    .cme { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; color: #16181d; }
    .cme * { box-sizing: border-box; }
    .cme h3 { margin: 1.25rem 0 .5rem; font-size: 1rem; }
    .cme table { border-collapse: collapse; width: 100%; }
    .cme td { padding: .5rem .6rem; border-bottom: 1px solid #dfe3e8; vertical-align: top; }
    .cme .t { color: ${accent}; font-weight: 600; text-decoration: none; }
    .cme .m { color: #5b6472; font-size: .88em; }
    .cme .g { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }
    .cme .c { border: 1px solid #dfe3e8; border-radius: 8px; padding: .75rem; }
    .cme img { width: 4rem; height: 4rem; object-fit: cover; border-radius: 50%; }
  `.replace(/\s+/g, ' ').trim();

  let inner = '';

  if (showsPeople(embed.feed)) {
    const gallery = embed.feed === 'speaker_gallery';
    inner += '<div class="g">';
    for (const p of data.people) {
      const name = escapeHtml(`${p.first_name} ${p.last_name}`.trim());
      inner += '<div class="c">';
      if (gallery && p.headshot) {
        inner += `<div><img src="${link(`/files/${p.headshot}`)}" alt="${name}"></div>`;
      }
      inner += `<div class="t">${name}</div>`;
      const role = [p.job_title, p.company].filter(Boolean).join(', ');
      if (role) inner += `<div class="m">${escapeHtml(role)}</div>`;
      if (embed.include_description && p.biography && !gallery) {
        inner += `<p class="m">${escapeHtml(p.biography)}</p>`;
      }
      inner += '</div>';
    }
    inner += '</div>';
  } else {
    const byDay = new Map();
    for (const s of data.sessions) {
      const day = s.starts_at ? localDay(s.starts_at, event.timezone) : 'To be scheduled';
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(s);
    }

    for (const [day, sessions] of byDay) {
      inner += `<h3>${escapeHtml(day)}</h3><table><tbody>`;
      for (const s of sessions) {
        const time = s.starts_at ? localTime(s.starts_at, event.timezone) : '';
        inner += '<tr>';
        inner += `<td class="m" style="white-space:nowrap">${escapeHtml(time)}</td>`;
        inner += `<td><a class="t" href="${link(`/sessions/${event.slug}/${s.code}`)}">`
          + `${escapeHtml(s.title)}</a>`;
        if (embed.include_speakers && s.speakers.length > 0) {
          inner += `<div class="m">${escapeHtml(s.speakers
            .map((p) => `${p.first_name} ${p.last_name}`.trim()).join(', '))}</div>`;
        }
        if (embed.include_description && s.description) {
          inner += `<div class="m">${escapeHtml(String(s.description).slice(0, 160))}</div>`;
        }
        inner += '</td>';
        if (embed.include_room) inner += `<td class="m">${escapeHtml(s.room_name ?? '')}</td>`;
        inner += '</tr>';
      }
      inner += '</tbody></table>';
    }
  }

  if (inner === '' || inner === '<div class="g"></div>') {
    inner = '<p class="m">Nothing published yet.</p>';
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(embed.name)}</title>
<style>${style}</style></head>
<body><div class="cme">${inner}</div></body></html>
`;
}
