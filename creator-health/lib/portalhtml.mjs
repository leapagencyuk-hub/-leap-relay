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
/* Sampled from LEAP's own Canva: the gaming ranking cards run a deep navy to
   blue gradient with white glow on everything that matters. #004AAD is the
   logo blue, straight off the mark. */
--brand:#004AAD; --brand-lift:#6aa6ff; --brand-deep:#00254f;
--navy:#041134; --navy-2:#071d44; --navy-3:#072d6c;
--bg:#030b1e; --card:#0a1733; --card-2:#071228; --line:#15295a;
--ink:#ffffff; --dim:#93a6c9;
--act:#ff5f6d; --watch:#ffb648; --good:#4fe08a; --idle:#5d6f91;
--glow:0 0 18px rgba(255,255,255,.28);
color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;color:var(--ink);
background:var(--bg);
background-image:radial-gradient(900px 600px at 18% -5%,var(--navy-3) 0%,transparent 60%),
radial-gradient(800px 700px at 100% 8%,#0a2a63 0%,transparent 55%),
linear-gradient(180deg,var(--navy) 0%,var(--bg) 55%);
background-attachment:fixed;
font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
-webkit-text-size-adjust:100%}
.wrap{max-width:1400px;margin:0 auto;
padding-left:max(16px,env(safe-area-inset-left,0px));
padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:18px}
.brandbar{display:flex;align-items:center;gap:11px;margin-bottom:14px}
.brandbar img{width:36px;height:36px;border-radius:10px;flex:0 0 auto;
box-shadow:0 0 16px rgba(0,74,173,.6)}
.brandbar .who{min-width:0}
.brandbar h1{font-size:19px;margin:0;letter-spacing:-.01em;text-wrap:balance}
.brandbar .meta{color:var(--dim);font-size:12.5px}
h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);
margin:30px 0 4px;font-weight:700}
h2 .count{color:var(--ink)}
.lede{color:var(--dim);font-size:12.5px;margin:0 0 11px}
.sub{color:var(--dim);font-size:13px;margin:0 0 6px}
.card{background:linear-gradient(180deg,rgba(13,30,66,.92),rgba(7,18,40,.92));
border:1px solid var(--line);border-radius:14px;padding:13px;margin-bottom:9px}
.stat .v,.brandbar h1{text-shadow:var(--glow)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:9px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:12px}
.stat.hero{background:linear-gradient(145deg,#0a59c4,var(--brand-deep));border-color:#1d6fe0;
box-shadow:0 0 26px rgba(10,89,196,.35)}
.stat .k{color:var(--dim);font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;font-weight:600}
.stat.hero .k{color:#cfe0f8}
.stat .v{font-size:21px;font-weight:680;margin-top:3px;font-variant-numeric:tabular-nums}
.stat.hero .v{color:#fff}
.pills{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 4px}
.pill{display:inline-flex;align-items:center;gap:6px;background:var(--card);
border:1px solid var(--line);border-radius:999px;padding:4px 11px;font-size:12.5px;color:var(--dim)}
.pill b{color:var(--ink);font-variant-numeric:tabular-nums}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.name{font-weight:670;min-width:0;flex:1 1 auto;overflow-wrap:anywhere}
.row .worth,.row .risk{flex:0 0 auto}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;
vertical-align:middle;flex:0 0 auto}
.dot.act,.act>.row .dot{background:var(--act)}
.dot.watch,.watch>.row .dot{background:var(--watch)}
.dot.good,.good>.row .dot{background:var(--good)}
.dot.idle,.idle>.row .dot{background:var(--idle)}
.card.act{border-left:3px solid var(--act)}
.card.protect{border-left:3px solid var(--brand-lift)}
.dot.protect,.protect>.chead .dot{background:var(--brand-lift)}
.card.watch{border-left:3px solid var(--watch)}
.card.good{border-left:3px solid var(--good)}
.card:target{outline:2px solid var(--brand-lift);outline-offset:3px;
box-shadow:0 0 24px rgba(106,166,255,.35);scroll-margin-top:16px}
.meta{color:var(--dim);font-size:12.5px;margin-top:5px;font-variant-numeric:tabular-nums}
.chead{display:flex;gap:11px;align-items:flex-start}
.chead .body{flex:1;min-width:0}
/* LEAP rings every creator photo in glowing white. It is the one treatment
   that appears on every card they have ever published, so it appears here. */
.ava{width:54px;height:54px;border-radius:50%;flex:0 0 auto;object-fit:cover;
border:2px solid rgba(255,255,255,.92);box-shadow:0 0 14px rgba(255,255,255,.35);
background:var(--card-2);order:2}
.ava.none{display:flex;align-items:center;justify-content:center;color:var(--dim);
font-size:19px;font-weight:700;border-color:rgba(255,255,255,.3);box-shadow:none}
/* Creator cards tile across a desktop and stack on a phone. The portal was
   using a thousand pixels of a three-thousand pixel screen. */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));
gap:9px;align-items:start}
@media(max-width:920px){.cards{grid-template-columns:1fr}}
/* auto-fit rather than a fixed four, so the tiles fall to two rows inside a
   narrow card instead of being squeezed. */
.quad{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:7px;margin-top:11px}
.q{background:rgba(3,11,30,.55);border:1px solid var(--line);border-radius:10px;padding:7px 8px;min-width:0}
.q .k{color:var(--dim);font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:700}
.q .v{font-size:14px;font-weight:680;font-variant-numeric:tabular-nums;margin-top:2px;
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.q .c{font-size:10.5px;font-variant-numeric:tabular-nums;margin-top:1px}
.q .then{color:var(--dim);font-size:10px;margin-top:2px;line-height:1.3;
font-variant-numeric:tabular-nums}
.msg{margin-top:11px;background:rgba(3,11,30,.6);border:1px solid var(--line);
border-radius:10px;padding:10px}
.msg .k{color:var(--dim);font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;
font-weight:700;margin-bottom:6px}
.msg textarea{width:100%;background:transparent;border:0;color:var(--ink);font:inherit;
font-size:12.5px;line-height:1.5;resize:vertical;min-height:112px;padding:0}
.msg textarea:focus{outline:2px solid var(--brand-lift);outline-offset:4px;border-radius:4px}
.copied{color:var(--good);font-size:11.5px;margin-left:8px}
@media(max-width:430px){.quad{grid-template-columns:repeat(2,1fr)}}
/* The banked list: dense, because there can be seventy of them and a coach
   wants to see the whole wall at once. */
.mini{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px}
/* The rank-up list, laid out the way Backstage lays it out: who, a bar, how
   far off, what it pays. A bar reads in a glance; "tier 1 to 1, maintaining"
   reads as nothing. */
.rank{display:grid;grid-template-columns:repeat(auto-fill,minmax(430px,1fr));gap:8px}
.rk{background:linear-gradient(180deg,rgba(13,30,66,.92),rgba(7,18,40,.92));
border:1px solid var(--line);border-radius:13px;padding:12px 13px}
.rk.done{border-left:3px solid var(--good)}
.rk.near{border-left:3px solid var(--watch)}
.rk .top{display:flex;gap:11px;align-items:center}
.rk img.f,.rk .ph{width:40px;height:40px;border-radius:50%;flex:0 0 auto;object-fit:cover;
border:2px solid rgba(255,255,255,.9);box-shadow:0 0 10px rgba(255,255,255,.3);
background:var(--card-2);display:flex;align-items:center;justify-content:center;
color:var(--dim);font-weight:700;font-size:15px}
.rk .who{flex:1;min-width:0}
.rk .nm{font-weight:670;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tier{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.03em;
color:#cfe0f8;border:1px solid #1d6fe0;background:rgba(0,74,173,.4);
border-radius:999px;padding:1px 8px;margin-top:3px}
.rk .pay{text-align:right;flex:0 0 auto}
.rk .pay .v{color:var(--good);font-weight:700;font-variant-numeric:tabular-nums;font-size:15px}
.rk .pay .l{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.05em}
.bar{height:7px;border-radius:999px;background:rgba(255,255,255,.1);margin-top:11px;overflow:hidden}
.bar span{display:block;height:100%;border-radius:999px;
background:linear-gradient(90deg,#1d6fe0,#6aa6ff)}
.rk.done .bar span{background:linear-gradient(90deg,#2aa567,var(--good))}
.rk .nums{display:flex;justify-content:space-between;gap:10px;margin-top:6px;
color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
.rk .nums b{color:var(--ink)}
.rk .acts{margin-top:10px}
.m{background:linear-gradient(180deg,rgba(13,30,66,.92),rgba(7,18,40,.92));
border:1px solid var(--line);border-left:3px solid var(--good);border-radius:12px;
padding:10px 11px;display:flex;gap:10px;align-items:center;min-width:0}
.m.watch{border-left-color:var(--watch)}
.m img,.m .ph{width:38px;height:38px;border-radius:50%;flex:0 0 auto;object-fit:cover;
border:2px solid rgba(255,255,255,.9);box-shadow:0 0 10px rgba(255,255,255,.3);
background:var(--card-2);display:flex;align-items:center;justify-content:center;
color:var(--dim);font-weight:700;font-size:14px}
.m .b{min-width:0;flex:1}
.m .h{font-weight:660;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.m .s{color:var(--dim);font-size:11.5px;font-variant-numeric:tabular-nums;margin-top:2px}
.m a.go{color:var(--brand-lift);font-size:11.5px;text-decoration:none;flex:0 0 auto}
.m a.go:hover{color:#fff}
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
  const initial = esc(String(r.username ?? '?').replace(/^@/, '').charAt(0).toUpperCase());
  const ava = r.avatar
    ? `<img class="ava" src="${esc(r.avatar)}" alt="" width="54" height="54" loading="lazy">`
    : `<div class="ava none" aria-hidden="true">${initial}</div>`;

  // Four numbers, each against the same point last month. A change we cannot
  // compute reads as a dash, never as zero — a creator in their first month has
  // no last month, and "0%" would say they stood still.
  const q = (label, stat, fmt) => {
    const change = stat?.change;
    const then = stat?.then;
    return `<div class="q"><div class="k">${esc(label)}</div>
<div class="v">${stat?.now == null ? '—' : fmt(stat.now)}</div>
<div class="c ${toneOf(change)}">${change == null ? '<span class="flat">no last month</span>' : signed(change)}</div>
${then == null ? '' : `<div class="then">from ${fmt(then)} ${esc(stat.thenNote ?? '')}</div>`}</div>`;
  };
  const mo = r.month ?? {};
  const hours = (x) => `${Number(x).toFixed(1)}h`;
  const quad = `<div class="quad">
${q('Diamonds', mo.diamonds, n)}
${q('Hours', mo.hours, hours)}
${q('LIVE days', mo.liveDays, n)}
${q('Fan club', mo.fanClub, n)}
</div>`;

  const msgId = `m-${esc(String(r.key ?? r.username).replace(/[^a-zA-Z0-9]/g, ''))}`;
  const message = d?.message ? `<div class="msg">
<div class="k">Message to send ${r.username ? `@${esc(r.username)}` : 'them'}</div>
<textarea id="${msgId}" readonly rows="6">${esc(d.message)}</textarea>
<div class="acts"><button class="btn" type="button" data-copy="${msgId}">Copy message</button></div>
</div>` : '';

  // Anchored by handle so a monitoring ping can link to this exact creator.
  // A card that says "open their card" and drops you at the top of a page of
  // thirty is a card that lied.
  const anchor = esc(String(r.username ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, ''));
  return `<div class="card ${esc(r.state)}"${anchor ? ` id="c-${anchor}"` : ''}>
<div class="chead">${ava}
<div class="body">
<div class="row"><span class="name"><span class="dot"></span>@${esc(r.username)}</span>${moneyLine ?? ''}</div>
<div class="meta">${r.group ? `${esc(r.group)} · ` : ''}${r.liveDays7} LIVE days / 7 · ${r.hours7.toFixed(1)}h this week${
  r.perHour ? ` · ${n(r.perHour)}/hour` : ''}${
  need ? ` · ${esc(need)}` : ''}${r.darkStreak >= 2 ? ` · dark ${r.darkStreak}d` : ''}</div>
</div></div>
${quad}
${d ? `<details class="why"><summary><span class="acts">
<span class="btn">What the data says</span>${tt}</span></summary>
<div class="body"><b>${esc(d.headline)}</b><p>${esc(d.detail)}</p>
${d.actions?.length ? `<ul>${d.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
${d.needsInsights ? '<div class="flag">Gift rate, ACU and watch duration are on the Creator Insights sheet, not here. Check it before the call.</div>' : ''}
${message}
</div></details>` : `<div class="acts">${tt}</div>`}
</div>`;
}

// The one piece of script on the page. Copy needs a click handler and there is
// no other way; everything else is plain HTML and CSS on purpose.
const COPY_JS = `<script>
document.addEventListener('click', function (ev) {
  var btn = ev.target.closest('[data-copy]');
  if (!btn) return;
  var ta = document.getElementById(btn.getAttribute('data-copy'));
  if (!ta) return;
  var done = function () {
    var tag = btn.parentNode.querySelector('.copied');
    if (!tag) { tag = document.createElement('span'); tag.className = 'copied'; btn.parentNode.appendChild(tag); }
    tag.textContent = 'Copied';
    setTimeout(function () { tag.textContent = ''; }, 2000);
  };
  // Older app views refuse the clipboard outright, so fall back to selecting
  // the text, which leaves the coach one keystroke away rather than stuck.
  try {
    navigator.clipboard.writeText(ta.value).then(done, function () { ta.focus(); ta.select(); });
  } catch (e) { ta.focus(); ta.select(); }
});
</script>`;

/**
 * One creator's rank-up standing, laid out the way Backstage lays it out.
 *
 * Who they are, a bar toward the next tier, how far off, and what it pays the
 * coach. The previous version said "tier 1 → 1 · maintaining", which is true
 * and tells a coach nothing they can act on; a bar and a number to go is a
 * target they can put in front of the creator.
 *
 * The message button carries that number to the creator, which is the one
 * place a figure is allowed through — see rankMessage in lib/portal.mjs.
 */
function rankRow(r, { money: showMoney = true, cur = 'GBP' } = {}) {
  const initial = esc(String(r.username ?? '?').replace(/^@/, '').charAt(0).toUpperCase());
  const ava = r.avatar
    ? `<img class="f" src="${esc(r.avatar)}" alt="" width="40" height="40" loading="lazy">`
    : `<div class="ph" aria-hidden="true">${initial}</div>`;
  const k = r.rank ?? {};
  const pctDone = Math.round((k.progress ?? 0) * 100);
  const done = !k.gap || k.gap <= 0;
  // Amber once they are most of the way there: that is the one worth a message
  // today rather than at the end of the month.
  const near = !done && (k.progress ?? 0) >= 0.6;
  const worth = k.rankedUp ? k.worth : k.worthIfCrossed;

  const msgId = `r-${esc(String(r.key ?? r.username).replace(/[^a-zA-Z0-9]/g, ''))}`;
  const msg = r.rankMessage ? `<div class="msg">
<div class="k">Message to send @${esc(r.username)}</div>
<textarea id="${msgId}" readonly rows="5">${esc(r.rankMessage)}</textarea>
<div class="acts"><button class="btn" type="button" data-copy="${msgId}">Copy message</button>
${r.tiktok ? `<a class="btn tt" href="${esc(r.tiktok)}" target="_blank" rel="noopener noreferrer">Open TikTok</a>` : ''}</div>
</div>` : '';

  return `<div class="rk ${done ? 'done' : near ? 'near' : ''}">
<div class="top">${ava}
<div class="who"><div class="nm">@${esc(r.username)}</div>
<span class="tier">Tier ${k.fromTier ?? 1}${k.rankedUp ? ` &rarr; ${k.toTier}` : ''}</span></div>
${showMoney && worth >= 0.01 ? `<div class="pay"><div class="v">${money(worth, cur)}</div>
<div class="l">${k.rankedUp ? 'banked' : 'if they land it'}</div></div>` : ''}
</div>
<div class="bar"><span style="width:${Math.max(2, pctDone)}%"></span></div>
<div class="nums"><span><b>${n(k.diamonds)}</b>${k.target ? ` / ${n(k.target)}` : ''}</span>
<span>${done
    ? (k.rankedUp ? 'Ranked up' : 'Holding this tier')
    : `<b>${n(k.gap)}</b> to go · ${n(k.needPerDay)}/day`}</span></div>
${msg ? `<details class="why"><summary><span class="acts"><span class="btn">Message them</span></span></summary>
<div class="body">${msg}</div></details>` : ''}
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
<div class="cards">${view.attention.map((r) => creatorCard(r, {
    // Below a pound it is not an incentive, it is clutter pretending to be one.
    money: hasMoney && r.atRisk >= (config.portal?.minMoneyShown ?? 1)
      ? `<span class="risk">${money(r.atRisk, cur)}/wk at risk</span>` : null,
  })).join('')}</div>${
  view.attentionMore ? `<div class="card"><div class="meta">${view.attentionMore} more are flagged and are in the full roster below. These are the ones worth your morning.</div></div>` : ''}` : `
<h2>Urgent <span class="count">(0)</span></h2>
<div class="card"><div class="empty">Nobody earning is sliding today. That is the good version of this section.</div></div>`;

  // 1b. Having a big month, and the week has eased off.
  const protect = view.protect?.length ? `
<h2>Protect the month <span class="count">(${view.protect.length})</span></h2>
<p class="lede">Well up on last month, and the last week has come off the boil. Not an emergency —
these are the ones to encourage, not to warn. Lead with the month.</p>
<div class="cards">${view.protect.map((r) => creatorCard(r)).join('')}</div>` : '';

  // 2. The 200k chase.
  const chase = view.chase.length ? `
<h2>200k graduation <span class="count">(${view.chase.length})</span></h2>
<p class="lede">A creator gets up to three monthly goes at 200,000 inside their first 90 days.
Closest first, and only those who can still get there at something like their current rate.${
  hasMoney && view.chaseTotal > 0 ? ` Closing every gap here is ${money(view.chaseTotal, cur)} to you.` : ''}${
  view.chaseOutOfReach ? ` ${view.chaseOutOfReach} more are inside their 90 days but too far off this month to chase.` : ''}</p>
<div class="cards">${view.chase.map((r) => creatorCard(r, {
    money: hasMoney && r.worthIfGraduates >= (config.portal?.minMoneyShown ?? 1)
      ? `<span class="worth">${money(r.worthIfGraduates, cur)}</span>` : null,
    need: `${n(r.graduation.remaining)} to go, ${n(r.graduation.requiredPerDay)}/day`,
  })).join('')}</div>
${view.graduated.length ? `<div class="card good"><div class="meta">${view.graduated.length} already past 200,000 this month: ${
  view.graduated.map((r) => `@${esc(r.username)}`).join(', ')}</div></div>` : ''}` : '';

  // 3. Rank up and maintain.
  const rank = (view.upside.length || view.banked.length) ? `
<h2>Rank up &amp; maintain <span class="count">(${view.upside.length + view.banked.length})</span></h2>
<p class="lede">The highest-value thing on this page per creator. A rank up pays you on their whole month; a maintain lost in the last week costs the same as a rank up never made.</p>
${view.upside.length ? `<div class="card"><div class="meta">
<b>${view.upside.length} still in reach${hasMoney ? `, worth ${money(view.upsideTotal, cur)} if you land them all` : ''}.</b>
Closest to their next tier first. Open "Message them" for something you can send as it is.</div></div>
<div class="rank">${view.upside.map((r) => rankRow(r, { money: hasMoney, cur })).join('')}</div>` : ''}
${view.banked.length ? `<div class="card"><div class="meta">
<b>Banked: ${view.banked.filter((r) => r.rank.rankedUp).length} ranked up, ${view.banked.filter((r) => r.rank.maintained).length} holding their tier.</b>
Already yours. Amber is closing on the next tier — those are worth a message today rather than on the 30th.</div></div>
<div class="rank">${view.banked.map((r) => rankRow(r, { money: hasMoney, cur })).join('')}</div>` : ''}` : '';

  const quests = view.quests.length ? `
<h2>Side quests <span class="count">(${view.quests.length})</span></h2>
<div class="cards">${view.quests.map((r) => creatorCard(r)).join('')}</div>` : '';

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
${view.counts.protect ? `<span class="pill"><span class="dot protect"></span><b>${view.counts.protect}</b> protect</span>` : ''}
<span class="pill"><span class="dot watch"></span><b>${view.counts.watch}</b> in reach</span>
<span class="pill"><span class="dot good"></span><b>${view.counts.good}</b> on track</span>
<span class="pill"><b>${view.counts.roster}</b> creators</span>
</div>
${stale(view.asOf, lastAsOf)}
${earnings}${urgent}${protect}${chase}${rank}${quests}${activation}${roster}
${COPY_JS}
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
