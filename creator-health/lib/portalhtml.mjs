// The portal, rendered, in LEAP's own colours.
//
// Self-contained HTML: no CDN, no framework, no build step, no JavaScript. A
// coach opens this on a phone from a Discord thread and it has to paint
// immediately on whatever connection they have. The logo is a data URI and the
// expanding sections are native <details>.
//
// No emojis. Coach-facing surfaces are plain, the same rule the coach cards
// follow. Colour carries the urgency instead, which is what Carla asked for: a
// coach should see somebody is red before they read a word.
//
// The page answers three questions in the order a coach should ask them —
// who is slipping, who can still land 200k, who can still rank up — and every
// creator on it carries three things: what the data says, a way to go and look
// at them, and what they are worth to the coach who fixes it.
//
// Every value interpolated here comes from an export TikTok produced, which
// means usernames and team names are untrusted strings. They all go through
// `esc`. There is no innerHTML anywhere.
import { STATE } from './portal.mjs';
import { LEAP_LOGO } from './brand.mjs';

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

// LEAP blue is the brand and the accent. The three state colours are separate
// from it on purpose: urgency is not branding, and a page where the brand
// colour also means "fine" cannot say "fine" and "LEAP" at the same time.
const CSS = `
:root{
--brand:#004AAD; --brand-lift:#5b9bf0; --brand-deep:#00357c;
--bg:#080c13; --card:#111822; --card-2:#0d141d; --line:#1e2836;
--ink:#f2f5f9; --dim:#8b97a8;
--act:#ff5a5a; --watch:#ffb03a; --good:#3ddc84; --idle:#5b6676;
color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
-webkit-text-size-adjust:100%}
.wrap{max-width:980px;margin:0 auto;
padding-left:max(16px,env(safe-area-inset-left,0px));
padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:18px}
.brandbar{display:flex;align-items:center;gap:11px;margin-bottom:14px}
.brandbar img{width:34px;height:34px;border-radius:9px;flex:0 0 auto}
.brandbar .who{min-width:0}
.brandbar h1{font-size:19px;margin:0;letter-spacing:-.01em;text-wrap:balance}
.brandbar .meta{color:var(--dim);font-size:12.5px}
h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);
margin:30px 0 4px;font-weight:700}
h2 .count{color:var(--ink)}
.lede{color:var(--dim);font-size:12.5px;margin:0 0 11px}
.sub{color:var(--dim);font-size:13px;margin:0 0 6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:13px;
padding:13px;margin-bottom:9px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:9px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:12px}
.stat.hero{background:linear-gradient(145deg,var(--brand),var(--brand-deep));border-color:#0a59c4}
.stat .k{color:var(--dim);font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;font-weight:600}
.stat.hero .k{color:#cfe0f8}
.stat .v{font-size:21px;font-weight:680;margin-top:3px;font-variant-numeric:tabular-nums}
.stat.hero .v{color:#fff}
.pills{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 4px}
.pill{display:inline-flex;align-items:center;gap:6px;background:var(--card);
border:1px solid var(--line);border-radius:999px;padding:4px 11px;font-size:12.5px;color:var(--dim)}
.pill b{color:var(--ink);font-variant-numeric:tabular-nums}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.name{font-weight:670;min-width:0;overflow-wrap:anywhere}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;
vertical-align:middle;flex:0 0 auto}
.dot.act,.act>.row .dot{background:var(--act)}
.dot.watch,.watch>.row .dot{background:var(--watch)}
.dot.good,.good>.row .dot{background:var(--good)}
.dot.idle,.idle>.row .dot{background:var(--idle)}
.card.act{border-left:3px solid var(--act)}
.card.watch{border-left:3px solid var(--watch)}
.card.good{border-left:3px solid var(--good)}
.meta{color:var(--dim);font-size:12.5px;margin-top:5px;font-variant-numeric:tabular-nums}
.worth{color:var(--good);font-weight:680;font-variant-numeric:tabular-nums;white-space:nowrap}
.risk{color:var(--act);font-weight:680;font-variant-numeric:tabular-nums;white-space:nowrap}
.up{color:var(--good)}.down{color:var(--act)}.flat{color:var(--dim)}
.acts{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}
.btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);
background:var(--card-2);color:var(--ink);border-radius:9px;padding:7px 11px;
font-size:12.5px;font-weight:600;cursor:pointer;text-decoration:none}
.btn:hover{border-color:var(--brand-lift);color:#fff}
.btn.tt{background:var(--brand);border-color:var(--brand);color:#fff}
.btn.tt:hover{background:#0a59c4}
details.why{margin-top:9px}
details.why>summary{list-style:none;cursor:pointer}
details.why>summary::-webkit-details-marker{display:none}
.why .body{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
.why .body b{display:block;font-size:13px;margin-bottom:4px}
.why .body p{margin:0 0 9px;color:var(--dim);font-size:13px}
.why ul{margin:0;padding-left:17px;color:var(--dim);font-size:13px}
.why li{margin-bottom:5px}
.why li::marker{color:var(--brand-lift)}
.flag{display:inline-block;font-size:11px;color:var(--watch);border:1px solid #4a3a16;
background:#201909;border-radius:7px;padding:4px 8px;margin-top:8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim);font-weight:600;font-size:10.5px;
text-transform:uppercase;letter-spacing:.05em;padding:6px 7px;border-bottom:1px solid var(--line)}
td{padding:8px 7px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right}
td a{color:var(--ink);text-decoration:none}
td a:hover{color:var(--brand-lift)}
a{color:var(--brand-lift);text-decoration:none}
a.teamlink{display:block;padding:13px;background:var(--card);border:1px solid var(--line);
border-radius:13px;margin-bottom:8px}
a.teamlink:hover{border-color:var(--brand-lift)}
details.fold>summary{list-style:none;cursor:pointer;font-size:12px;letter-spacing:.09em;
text-transform:uppercase;color:var(--dim);margin:30px 0 10px;font-weight:700;
display:flex;align-items:center;gap:8px}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary::after{content:"";width:7px;height:7px;border-right:2px solid var(--dim);
border-bottom:2px solid var(--dim);transform:rotate(45deg);margin-top:-4px}
details.fold[open]>summary::after{transform:rotate(-135deg);margin-top:2px}
details.fold>summary:hover{color:var(--ink)}
.note{color:var(--dim);font-size:11px;line-height:1.5;margin-top:14px;
border-top:1px solid var(--line);padding-top:12px}
.warn{background:#201909;border-color:#4a3a16;color:#ffce8a}
.empty{color:var(--dim);font-size:13px;padding:4px 0}
.tag{display:inline-block;font-size:11px;color:var(--dim);border:1px solid var(--line);
border-radius:999px;padding:1px 8px;margin-left:6px;vertical-align:middle;white-space:nowrap}
@media(max-width:560px){.hide-s{display:none}}
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

const header = (title, meta) => `<div class="brandbar">
<img src="${LEAP_LOGO}" alt="LEAP" width="34" height="34">
<div class="who"><h1>${esc(title)}</h1><div class="meta">${esc(meta)}</div></div></div>`;

const stale = (asOf, lastAsOf) => (asOf && lastAsOf && asOf < lastAsOf
  ? `<div class="card warn">Showing ${esc(asOf)}. Newer data is held, up to ${esc(lastAsOf)}.</div>` : '');

/**
 * One creator.
 *
 * `money` is whatever this section is about — what landing them is worth, or
 * what losing them costs. A creator card with no number on it is a fact; with
 * one it is a reason, and Carla's whole argument for the rank-up cards was that
 * a coach will watch somebody's LIVE for fifty pounds and will not for nothing.
 */
function creatorCard(r, { money: moneyLine = null, need = null } = {}) {
  const d = r.diagnosis;
  const tt = r.tiktok
    ? `<a class="btn tt" href="${esc(r.tiktok)}" target="_blank" rel="noopener noreferrer">Open TikTok</a>`
    : '';
  return `<div class="card ${esc(r.state)}">
<div class="row"><span class="name"><span class="dot"></span>@${esc(r.username)}${
  r.group ? `<span class="tag">${esc(r.group)}</span>` : ''}</span>${moneyLine ?? ''}</div>
<div class="meta">${n(r.diamonds)} this month <span class="${toneOf(r.change)}">${signed(r.change)}</span>
 · ${r.liveDays7} LIVE days / 7 · ${r.hours7.toFixed(1)}h${
  r.perHour ? ` · ${n(r.perHour)}/hour` : ''}${
  need ? ` · ${esc(need)}` : ''}${r.darkStreak >= 2 ? ` · dark ${r.darkStreak}d` : ''}</div>
${d ? `<details class="why"><summary><span class="acts">
<span class="btn">What the data says</span>${tt}</span></summary>
<div class="body"><b>${esc(d.headline)}</b><p>${esc(d.detail)}</p>
${d.actions?.length ? `<ul>${d.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
${d.needsInsights ? '<div class="flag">Gift rate, ACU and watch duration are on the Creator Insights sheet, not here. Check it before the call.</div>' : ''}
</div></details>` : `<div class="acts">${tt}</div>`}
</div>`;
}

/** The coach's own page. Their creators, nobody else's. */
export function coachPage(view, { lastAsOf = null, config = {}, signedIn = false, back = null } = {}) {
  const e = view.earnings;
  const cur = config.leaped?.currency ?? 'GBP';
  const hasMoney = Boolean(e) && !view.earningsHidden;

  const earnings = !hasMoney ? '' : `
<h2>Your month</h2>
<div class="grid">
<div class="stat hero"><div class="k">Earned so far</div><div class="v">${money(e.total, cur)}</div></div>
<div class="stat"><div class="k">Still on the table</div><div class="v">${money(view.upsideTotal + view.chaseTotal, cur)}</div></div>
<div class="stat"><div class="k">Diamonds</div><div class="v">${n(e.diamonds)}</div></div>
<div class="stat"><div class="k">Recruits leaped</div><div class="v">${e.leapedCount}</div></div>
</div>
<div class="card"><div class="meta">
Fixed ${money(e.base, cur)} · recruits ${money(e.recruitBonus, cur)} · rank ups ${money(e.rankUpBonus, cur)} · diamond share ${money(e.incrementalShare, cur)}
${e.goals ? `<br>Goals: ${e.goals.diamondsHit ? 'diamonds met' : `${n(e.goals.diamondsToGo)} diamonds to go`} · ${
  e.goals.recruitsHit ? 'recruits met' : `${e.goals.recruitsToGo} recruits to go`}. Both met takes you to ${money(e.totalWithGoals, cur)}.` : ''}
</div></div>`;

  // 1. Urgent.
  const urgent = view.attention.length ? `
<h2>Urgent <span class="count">(${view.attention.length})</span></h2>
<p class="lede">Slipping now, and still earning enough to be worth the call.${
  hasMoney && view.atRiskTotal > 0 ? ` About ${money(view.atRiskTotal, cur)} a week of your pay is in this list.` : ''}</p>
${view.attention.map((r) => creatorCard(r, {
    money: hasMoney && r.atRisk > 0.01 ? `<span class="risk">${money(r.atRisk, cur)}/wk at risk</span>` : null,
  })).join('')}${
  view.attentionMore ? `<div class="card"><div class="meta">${view.attentionMore} more are flagged and are in the full roster below. These are the ones worth your morning.</div></div>` : ''}` : `
<h2>Urgent <span class="count">(0)</span></h2>
<div class="card"><div class="empty">Nobody earning is sliding today. That is the good version of this section.</div></div>`;

  // 2. The 200k chase.
  const chase = view.chase.length ? `
<h2>200k graduation <span class="count">(${view.chase.length})</span></h2>
<p class="lede">A creator gets up to three monthly goes at 200,000 inside their first 90 days.
Closest first, and only those who can still get there at something like their current rate.${
  hasMoney && view.chaseTotal > 0 ? ` Closing every gap here is ${money(view.chaseTotal, cur)} to you.` : ''}${
  view.chaseOutOfReach ? ` ${view.chaseOutOfReach} more are inside their 90 days but too far off this month to chase.` : ''}</p>
${view.chase.map((r) => creatorCard(r, {
    money: hasMoney && r.worthIfGraduates > 0.01 ? `<span class="worth">${money(r.worthIfGraduates, cur)}</span>` : null,
    need: `${n(r.graduation.remaining)} to go, ${n(r.graduation.requiredPerDay)}/day`,
  })).join('')}
${view.graduated.length ? `<div class="card good"><div class="meta">${view.graduated.length} already past 200,000 this month: ${
  view.graduated.map((r) => `@${esc(r.username)}`).join(', ')}</div></div>` : ''}` : '';

  // 3. Rank up and maintain.
  const rank = (view.upside.length || view.banked.length) ? `
<h2>Rank up &amp; maintain <span class="count">(${view.upside.length + view.banked.length})</span></h2>
<p class="lede">The highest-value thing on this page per creator. A rank up pays you on their whole month; a maintain lost in the last week costs the same as a rank up never made.</p>
${view.upside.length ? `<div class="card"><div class="meta">${view.upside.length} still in reach${
  hasMoney ? `, worth <span class="worth">${money(view.upsideTotal, cur)}</span> if you land them all` : ''}. Only creators who can still get there are listed.</div></div>
${view.upside.map((r) => creatorCard(r, {
    money: hasMoney && r.rank.worthIfCrossed ? `<span class="worth">${money(r.rank.worthIfCrossed, cur)}</span>` : null,
    need: `${n(r.rank.gap)} to tier ${r.rank.toTier + 1}, ${n(r.rank.needPerDay)}/day`,
  })).join('')}` : ''}
${view.banked.length ? `<details class="fold"><summary>Banked — do not lose these (${view.banked.length})</summary>
<div class="card"><table><tr><th>Creator</th><th class="num">Diamonds</th><th class="num hide-s">Tier</th><th class="num">State</th></tr>
${view.banked.map((r) => `<tr><td><span class="dot good"></span>${
  r.tiktok ? `<a href="${esc(r.tiktok)}" target="_blank" rel="noopener noreferrer">@${esc(r.username)}</a>` : `@${esc(r.username)}`}</td>
<td class="num">${n(r.diamonds)}</td><td class="num hide-s">${r.rank.fromTier} &rarr; ${r.rank.toTier}</td>
<td class="num">${r.rank.rankedUp ? 'ranked up' : 'maintained'}</td></tr>`).join('')}</table></div></details>` : ''}` : '';

  const quests = view.quests.length ? `
<h2>Side quests <span class="count">(${view.quests.length})</span></h2>
${view.quests.map((r) => creatorCard(r)).join('')}` : '';

  const activation = view.activation.length ? `
<details class="fold"><summary>Never started (${view.activation.length})</summary>
<div class="card"><div class="meta">These have not earned yet. That is an activation conversation,
not a coaching one, and it is a different call to make.</div></div>
<div class="card"><table><tr><th>Creator</th><th class="num">Joined</th><th class="num">Diamonds</th><th class="num hide-s">Days/7</th></tr>
${view.activation.slice(0, 25).map((r) => `<tr><td><span class="dot idle"></span>${
  r.tiktok ? `<a href="${esc(r.tiktok)}" target="_blank" rel="noopener noreferrer">@${esc(r.username)}</a>` : `@${esc(r.username)}`}</td>
<td class="num">${esc(r.joinDate ?? '—')}</td><td class="num">${n(r.diamonds)}</td>
<td class="num hide-s">${r.liveDays7}</td></tr>`).join('')}</table>
${view.activation.length > 25 ? `<div class="meta">and ${view.activation.length - 25} more</div>` : ''}</div></details>` : '';

  const rest = view.rows.filter((r) => r.state !== STATE.ACT);
  const roster = `
<details class="fold"><summary>Everyone (${view.counts.roster})</summary>
<div class="card"><table>
<tr><th>Creator</th><th class="num">Diamonds</th><th class="num">MoM</th><th class="num hide-s">Days/7</th><th class="num hide-s">Hours/7</th></tr>
${rest.map((r) => `<tr><td><span class="dot ${esc(r.state)}"></span>${
  r.tiktok ? `<a href="${esc(r.tiktok)}" target="_blank" rel="noopener noreferrer">@${esc(r.username)}</a>` : `@${esc(r.username)}`}</td>
<td class="num">${n(r.diamonds)}</td><td class="num ${toneOf(r.change)}">${signed(r.change) || '—'}</td>
<td class="num hide-s">${r.liveDays7}</td><td class="num hide-s">${r.hours7.toFixed(1)}</td></tr>`).join('')}
</table></div></details>`;

  return page(`${view.name} — LEAP`, `
${back ? `<p class="sub"><a href="${esc(back)}">&larr; all coaches</a></p>` : ''}
${header(view.name, `${view.teams.join(' · ') || 'no team'} · data to ${view.asOf}`)}
<div class="pills">
<span class="pill"><span class="dot act"></span><b>${view.counts.act}</b> urgent</span>
<span class="pill"><span class="dot watch"></span><b>${view.counts.watch}</b> in reach</span>
<span class="pill"><span class="dot good"></span><b>${view.counts.good}</b> on track</span>
<span class="pill"><b>${view.counts.roster}</b> creators</span>
</div>
${stale(view.asOf, lastAsOf)}
${earnings}${urgent}${chase}${rank}${quests}${activation}${roster}
${hasMoney ? `<p class="note">${esc(EARNINGS_DISCLAIMER)}</p>` : ''}
${signedIn ? '<p class="note"><a href="/portal/logout">Sign out</a></p>' : ''}
<p class="note">Diamonds are month to date and reset on the 1st. The export runs a day
behind, so today's streams appear tomorrow. Gift rate, ACU and watch duration live on the
Creator Insights sheet and are not in this data yet.</p>`);
}

/** The directors' page: the whole network, every coach a door. */
export function directorPage(portal, links, { lastAsOf = null, config = {}, signedIn = false } = {}) {
  const cur = config.leaped?.currency ?? 'GBP';
  const net = portal.network;
  const linkFor = (coach) => links?.find((l) => l.coach === coach)?.url ?? null;
  return page('LEAP network', `
${header('LEAP', `${portal.coaches.length} coaches · ${net.roster} creators · data to ${portal.asOf}`)}
${stale(portal.asOf, lastAsOf)}
<div class="grid">
<div class="stat hero"><div class="k">Diamonds</div><div class="v">${n(net.diamonds)}</div></div>
<div class="stat"><div class="k">Urgent</div><div class="v">${net.act}</div></div>
<div class="stat"><div class="k">Rank ups</div><div class="v">${net.rankUps}</div></div>
<div class="stat"><div class="k">Maintains</div><div class="v">${net.maintains}</div></div>
<div class="stat"><div class="k">On the table</div><div class="v">${money(net.upsideTotal, cur)}</div></div>
<div class="stat"><div class="k">Payroll</div><div class="v">${money(net.payroll, cur)}</div></div>
</div>
<h2>Coaches</h2>
<p class="lede">Each one opens exactly what that coach sees.</p>
${portal.coaches.map((c) => {
    const url = linkFor(c.coach);
    const inner = `<div class="row"><span class="name">${esc(c.name)}</span>
<span class="meta">${n(c.earnings?.diamonds ?? c.diamonds)} diamonds</span></div>
<div class="meta"><span class="dot act"></span>${c.counts.act}
<span class="dot watch" style="margin-left:8px"></span>${c.counts.watch}
<span class="dot good" style="margin-left:8px"></span>${c.counts.good}
 · ${c.counts.roster} creators · ${money(c.upsideTotal + c.chaseTotal, cur)} in reach${
  c.earnings && !c.earningsHidden ? ` · pay ${money(c.earnings.total, cur)}` : ''}</div>`;
    return url ? `<a class="teamlink" href="${esc(url)}">${inner}</a>`
      : `<div class="card">${inner}</div>`;
  }).join('')}
<p class="note">${esc(EARNINGS_DISCLAIMER)}</p>
${signedIn ? '<p class="note"><a href="/portal/logout">Sign out</a></p>' : ''}
<p class="note">A coach's own link shows them their roster and nobody else's.</p>`);
}

/** Offered when Discord is configured but the visitor has not signed in. */
export function signInPage({ error = null } = {}) {
  return page('LEAP', `${header('LEAP', 'Coach portal')}
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
  return page('LEAP', `${header('LEAP', 'Coach portal')}
<p class="sub">That Discord account is not linked to a coach yet. Ask a director to add it,
and tell them which account you signed in with.</p>
<p class="sub"><a href="/portal/logout">Sign in as somebody else</a></p>`);
}

/** What a bad or missing token gets. Deliberately says nothing. */
export function deniedPage() {
  return page('LEAP', `${header('LEAP', 'Coach portal')}
<p class="sub">This link is not valid. Ask a director for a new one.</p>`);
}

/** What every portal route serves when no secret is configured. */
export function offPage() {
  return page('LEAP', `${header('LEAP', 'Coach portal')}
<p class="sub">No PORTAL_SECRET is set on this deployment, so no portal is served.</p>`);
}
