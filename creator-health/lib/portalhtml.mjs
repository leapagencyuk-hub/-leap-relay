// The portal, rendered.
//
// Self-contained HTML: no CDN, no framework, no build step. A coach opens this
// on a phone in a Discord thread and it has to paint immediately on whatever
// connection they have. Everything is inline.
//
// No emojis. Coach-facing surfaces are plain, the same rule the coach cards
// follow. Colour carries the urgency instead, which is what Carla asked for:
// a coach should see that somebody is red before they read a word.
//
// Every value interpolated here comes from an export TikTok produced, which
// means usernames and team names are untrusted strings. They all go through
// `esc`. There is no innerHTML anywhere.
import { STATE } from './portal.mjs';

/** The line that must appear beside any money a coach is shown. */
export const EARNINGS_DISCLAIMER = 'THIS IS FOR VISUAL PURPOSES AND A ROUGH ESTIMATE OF YOUR INCOME, NOT EXACT. FOR EXACT FIGURES TALK TO THE DIRECTORS';

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const n = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-GB') : '—');
const money = (x, cur = 'GBP') => (Number.isFinite(x)
  ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(x)
  : '—');
const signed = (x) => (x == null ? '' : `${x > 0 ? '+' : ''}${Math.round(x * 100)}%`);
const toneOf = (x) => (x == null ? '' : x > 0.02 ? 'up' : x < -0.02 ? 'down' : 'flat');

const CSS = `
:root{--bg:#0d0f13;--card:#161a21;--line:#242a34;--ink:#e8ecf2;--dim:#8d97a8;
--act:#ff5c5c;--watch:#ffb03a;--good:#35d07f;--idle:#5b6676;--accent:#7aa2ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
-webkit-text-size-adjust:100%}
.wrap{max-width:960px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0 0 2px}
h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);
margin:28px 0 10px;font-weight:600}
.sub{color:var(--dim);font-size:13px;margin:0 0 4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;
padding:14px;margin-bottom:10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
.stat .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.stat .v{font-size:22px;font-weight:650;margin-top:4px;font-variant-numeric:tabular-nums}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.name{font-weight:650}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;
vertical-align:middle;flex:0 0 auto}
.act .dot,.dot.act{background:var(--act)}
.watch .dot,.dot.watch{background:var(--watch)}
.good .dot,.dot.good{background:var(--good)}
.idle .dot,.dot.idle{background:var(--idle)}
.card.act{border-left:3px solid var(--act)}
.card.watch{border-left:3px solid var(--watch)}
.card.good{border-left:3px solid var(--good)}
.meta{color:var(--dim);font-size:12.5px;margin-top:6px;font-variant-numeric:tabular-nums}
.why{margin-top:9px;padding-top:9px;border-top:1px solid var(--line)}
.why b{display:block;font-size:13px;margin-bottom:3px}
.why p{margin:0;color:var(--dim);font-size:13px}
.up{color:var(--good)}.down{color:var(--act)}.flat{color:var(--dim)}
.worth{color:var(--good);font-weight:650;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim);font-weight:600;font-size:11px;
text-transform:uppercase;letter-spacing:.05em;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right}
a{color:var(--accent);text-decoration:none}
a.teamlink{display:block;padding:12px;background:var(--card);border:1px solid var(--line);
border-radius:12px;margin-bottom:8px}
.note{color:var(--dim);font-size:11px;line-height:1.45;margin-top:14px;
border-top:1px solid var(--line);padding-top:12px}
.warn{background:#2a1d10;border-color:#5a3a16;color:#ffce8a}
.empty{color:var(--dim);font-size:13px;padding:4px 0}
details{margin:0}
details>summary{list-style:none;cursor:pointer;font-size:13px;letter-spacing:.08em;
text-transform:uppercase;color:var(--dim);margin:28px 0 10px;font-weight:600;
display:flex;align-items:center;gap:8px}
details>summary::-webkit-details-marker{display:none}
details>summary::after{content:"";width:7px;height:7px;border-right:2px solid var(--dim);
border-bottom:2px solid var(--dim);transform:rotate(45deg);margin-top:-4px}
details[open]>summary::after{transform:rotate(-135deg);margin-top:2px}
details>summary:hover{color:var(--ink)}
.tag{display:inline-block;font-size:11px;color:var(--dim);border:1px solid var(--line);
border-radius:999px;padding:1px 8px;margin-left:6px;vertical-align:middle}
@media(max-width:560px){.wrap{padding:12px}.hide-s{display:none}}
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

const stale = (asOf, lastAsOf) => (asOf && lastAsOf && asOf < lastAsOf
  ? `<div class="card warn">Showing ${esc(asOf)}. Newer data is held, up to ${esc(lastAsOf)}.</div>` : '');

/** One creator, as a card: who, where they are, and what they need. */
function creatorCard(r, { showWorth = false } = {}) {
  const d = r.diagnosis;
  const worth = showWorth && r.rank?.worthIfCrossed
    ? `<span class="worth">${money(r.rank.worthIfCrossed)}</span>` : '';
  const need = r.rank?.gap
    ? `${n(r.rank.gap)} to go, ${n(r.rank.needPerDay)}/day`
    : r.graduation && !r.graduation.done
      ? `${n(r.graduation.remaining)} off 200k`
      : '';
  return `<div class="card ${esc(r.state)}">
<div class="row"><span class="name"><span class="dot"></span>@${esc(r.username)}${
  r.group ? `<span class="tag">${esc(r.group)}</span>` : ''}</span>${worth}</div>
<div class="meta">${n(r.diamonds)} this month <span class="${toneOf(r.change)}">${signed(r.change)}</span>
 · ${r.liveDays7} LIVE days / 7 · ${r.hours7.toFixed(1)}h${
  need ? ` · ${esc(need)}` : ''}${r.darkStreak >= 2 ? ` · dark ${r.darkStreak}d` : ''}</div>
${d ? `<div class="why"><b>${esc(d.headline)}</b><p>${esc(d.detail)}</p></div>` : ''}
</div>`;
}

/** The coach's own page. Their creators, nobody else's. */
export function coachPage(view, { lastAsOf = null, config = {}, signedIn = false, back = null } = {}) {
  const e = view.earnings;
  const cur = config.leaped?.currency ?? 'GBP';
  const earnings = !e || view.earningsHidden ? '' : `
<h2>Your month</h2>
<div class="grid">
<div class="stat"><div class="k">Earned so far</div><div class="v">${money(e.total, cur)}</div></div>
<div class="stat"><div class="k">Diamonds</div><div class="v">${n(e.diamonds)}</div></div>
<div class="stat"><div class="k">Recruits leaped</div><div class="v">${e.leapedCount}</div></div>
<div class="stat"><div class="k">Rank ups</div><div class="v">${e.rankUps}</div></div>
</div>
<div class="card"><div class="meta">
Fixed ${money(e.base, cur)} · recruits ${money(e.recruitBonus, cur)} · rank ups ${money(e.rankUpBonus, cur)} · diamond share ${money(e.incrementalShare, cur)}
${e.goals ? `<br>Goals: ${e.goals.diamondsHit ? 'diamonds met' : `${n(e.goals.diamondsToGo)} diamonds to go`} · ${
  e.goals.recruitsHit ? 'recruits met' : `${e.goals.recruitsToGo} recruits to go`}. Both met takes you to ${money(e.totalWithGoals, cur)}.` : ''}
</div></div>`;

  const upside = view.upside.length ? `
<h2>Worth the most this week</h2>
<div class="card"><div class="meta">Land all ${view.upside.length} and it is
<span class="worth">${money(view.upsideTotal, cur)}</span> more on your month. Only creators still in reach are listed.</div></div>
${view.upside.map((r) => creatorCard(r, { showWorth: true })).join('')}` : '';

  const attention = view.attention.length ? `
<h2>Needs you now</h2>${view.attention.map((r) => creatorCard(r)).join('')}${
  view.attentionMore ? `<div class="card"><div class="meta">${view.attentionMore} more are flagged and are in the roster below. These are the ones worth your morning.</div></div>` : ''}` : '';

  const banked = view.banked.length ? `
<details><summary>Banked — do not lose these (${view.banked.length})</summary>
<div class="card"><div class="meta">${view.banked.filter((r) => r.rank.rankedUp).length} ranked up,
${view.banked.filter((r) => r.rank.maintained).length} maintaining. A maintain lost in the last week costs the same as a rank up never made.</div></div>
<div class="card"><table><tr><th>Creator</th><th class="num">Diamonds</th><th class="num hide-s">Tier</th><th class="num">State</th></tr>
${view.banked.map((r) => `<tr><td><span class="dot good"></span>@${esc(r.username)}</td>
<td class="num">${n(r.diamonds)}</td><td class="num hide-s">${r.rank.fromTier} → ${r.rank.toTier}</td>
<td class="num">${r.rank.rankedUp ? 'ranked up' : 'maintained'}</td></tr>`).join('')}</table></div></details>` : '';

  const quests = view.quests.length ? `
<h2>Side quests</h2>${view.quests.map((r) => creatorCard(r)).join('')}` : '';

  const activation = view.activation.length ? `
<details><summary>Never started (${view.activation.length})</summary>
<div class="card"><div class="meta">These have not earned yet. That is an activation
conversation, not a coaching one, and it is a different call to make.</div></div>
<div class="card"><table><tr><th>Creator</th><th class="num">Joined</th><th class="num">Diamonds</th><th class="num hide-s">Days/7</th></tr>
${view.activation.slice(0, 25).map((r) => `<tr><td><span class="dot idle"></span>@${esc(r.username)}</td>
<td class="num">${esc(r.joinDate ?? '—')}</td><td class="num">${n(r.diamonds)}</td>
<td class="num hide-s">${r.liveDays7}</td></tr>`).join('')}</table>
${view.activation.length > 25 ? `<div class="meta">and ${view.activation.length - 25} more</div>` : ''}</div></details>` : '';

  const grad = view.graduation.filter((g) => g.ladder.total > 0).map((g) => {
    const l = g.ladder;
    const named = [...l.closest, ...l.bestPlaced].slice(0, 5);
    return `<div class="card"><div class="row"><span class="name">${esc(g.team)}</span>
<span class="meta">${l.graduated} graduated · ${l.closest.length} inside 100k</span></div>
${named.length ? `<div class="meta">${named.map((r) => `@${esc(r.username)} ${n(r.monthToDate)}`).join(' · ')}</div>`
      : '<div class="empty">Nobody in reach this month.</div>'}</div>`;
  }).join('');

  const rest = view.rows.filter((r) => r.state !== STATE.ACT);
  const roster = `
<details><summary>Everyone (${view.counts.roster})</summary>
<div class="card"><table>
<tr><th>Creator</th><th class="num">Diamonds</th><th class="num">MoM</th><th class="num hide-s">Days/7</th><th class="num hide-s">Hours/7</th></tr>
${rest.map((r) => `<tr><td><span class="dot ${esc(r.state)}"></span>@${esc(r.username)}</td>
<td class="num">${n(r.diamonds)}</td><td class="num ${toneOf(r.change)}">${signed(r.change) || '—'}</td>
<td class="num hide-s">${r.liveDays7}</td><td class="num hide-s">${r.hours7.toFixed(1)}</td></tr>`).join('')}
</table></div></details>`;

  return page(`${view.name} — LEAP`, `
${back ? `<p class="sub"><a href="${esc(back)}">&larr; all coaches</a></p>` : ''}
<h1>${esc(view.name)}</h1>
<p class="sub">${esc(view.teams.join(' · ') || 'no team')} · data to ${esc(view.asOf)}</p>
<p class="sub"><span class="dot act"></span>${view.counts.act} need you
<span class="dot watch" style="margin-left:10px"></span>${view.counts.watch} in reach
<span class="dot good" style="margin-left:10px"></span>${view.counts.good} on track</p>
${stale(view.asOf, lastAsOf)}
${earnings}${attention}${upside}${quests}${banked}${activation}
${grad ? `<h2>200k graduation</h2>${grad}` : ''}
${roster}
<p class="note">${esc(EARNINGS_DISCLAIMER)}</p>
${signedIn ? '<p class="note"><a href="/portal/logout">Sign out</a></p>' : ''}
<p class="note">Diamonds are month to date and reset on the 1st. The export runs a day
behind, so today's streams appear tomorrow. Gift rate, ACU and watch duration live on
the Creator Insights sheet and are not shown here yet.</p>`);
}

/** The directors' page: the whole network, every coach a door. */
export function directorPage(portal, links, { lastAsOf = null, config = {}, signedIn = false } = {}) {
  const cur = config.leaped?.currency ?? 'GBP';
  const net = portal.network;
  const linkFor = (coach) => links?.find((l) => l.coach === coach)?.url ?? null;
  return page('LEAP — network', `
<h1>LEAP</h1>
<p class="sub">Data to ${esc(portal.asOf)} · ${portal.coaches.length} coaches · ${net.roster} creators</p>
${stale(portal.asOf, lastAsOf)}
<div class="grid">
<div class="stat"><div class="k">Diamonds</div><div class="v">${n(net.diamonds)}</div></div>
<div class="stat"><div class="k">Need action</div><div class="v">${net.act}</div></div>
<div class="stat"><div class="k">Rank ups</div><div class="v">${net.rankUps}</div></div>
<div class="stat"><div class="k">Maintains</div><div class="v">${net.maintains}</div></div>
<div class="stat"><div class="k">On the table</div><div class="v">${money(net.upsideTotal, cur)}</div></div>
<div class="stat"><div class="k">Payroll</div><div class="v">${money(net.payroll, cur)}</div></div>
</div>
<h2>Coaches</h2>
${portal.coaches.map((c) => {
    const url = linkFor(c.coach);
    const inner = `<div class="row"><span class="name">${esc(c.name)}</span>
<span class="meta">${n(c.earnings?.diamonds ?? c.diamonds)} diamonds</span></div>
<div class="meta"><span class="dot act"></span>${c.counts.act}
<span class="dot watch" style="margin-left:8px"></span>${c.counts.watch}
<span class="dot good" style="margin-left:8px"></span>${c.counts.good}
 · ${c.counts.roster} creators · ${money(c.upsideTotal, cur)} in reach${
  c.earnings && !c.earningsHidden ? ` · pay ${money(c.earnings.total, cur)}` : ''}</div>`;
    return url ? `<a class="teamlink" href="${esc(url)}">${inner}</a>`
      : `<div class="card">${inner}</div>`;
  }).join('')}
<p class="note">${esc(EARNINGS_DISCLAIMER)}</p>
${signedIn ? '<p class="note"><a href="/portal/logout">Sign out</a></p>' : ''}
<p class="note">Each coach's name opens exactly what that coach sees. Their own link
shows them their roster and nobody else's.</p>`);
}

/** Offered when Discord is configured but the visitor has not signed in. */
export function signInPage({ error = null } = {}) {
  return page('LEAP', `<h1>LEAP</h1>
<p class="sub">Sign in with Discord to see your creators.</p>
${error ? `<div class="card warn">${esc(error)}</div>` : ''}
<p class="sub"><a href="/portal">Sign in with Discord</a></p>`);
}

/**
 * Signed in, but this Discord account is on no list.
 *
 * Named plainly on purpose. A coach whose id has not been added yet would read
 * a bare 404 as "the portal is broken" and stop trying; this tells them exactly
 * what to ask for, and tells nobody anything they did not already know.
 */
export function notListedPage() {
  return page('LEAP', `<h1>Not on the list</h1>
<p class="sub">That Discord account is not linked to a coach yet. Ask a director to add it,
and tell them the account you signed in with.</p>
<p class="sub"><a href="/portal/logout">Sign in as somebody else</a></p>`);
}

/** What a bad or missing token gets. Deliberately says nothing. */
export function deniedPage() {
  return page('LEAP', '<h1>Not found</h1><p class="sub">This link is not valid. Ask a director for a new one.</p>');
}

/** What every portal route serves when no secret is configured. */
export function offPage() {
  return page('LEAP', '<h1>Portal is off</h1><p class="sub">No PORTAL_SECRET is set on this deployment, so no portal is served.</p>');
}
