import json, html
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Table, TableStyle, KeepTogether)

D = json.load(open('quests.json'))
Q = D['quests']
OUT = '/home/user/-leap-relay/creator-health/docs/October-Side-Quests-preview.pdf'
INK  = colors.HexColor('#15181d'); MUTE = colors.HexColor('#5b6572')
RULE = colors.HexColor('#dfe3e8'); ACC  = colors.HexColor('#0f5ad6')
GOOD = colors.HexColor('#0b7a43'); WARN = colors.HexColor('#b45309')
BOX  = colors.HexColor('#f4f6f9')

S = {
 'h1':   ParagraphStyle('h1', fontName='Helvetica-Bold', fontSize=20, leading=24, textColor=INK, spaceAfter=2),
 'sub':  ParagraphStyle('sub', fontName='Helvetica', fontSize=10.5, leading=14, textColor=MUTE, spaceAfter=12),
 'h2':   ParagraphStyle('h2', fontName='Helvetica-Bold', fontSize=12.5, leading=15, textColor=INK, spaceBefore=14, spaceAfter=6),
 'name': ParagraphStyle('name', fontName='Helvetica-Bold', fontSize=11.5, leading=14, textColor=INK, spaceAfter=1),
 'meta': ParagraphStyle('meta', fontName='Helvetica', fontSize=8.6, leading=11, textColor=MUTE, spaceAfter=5),
 'p':    ParagraphStyle('p', fontName='Helvetica', fontSize=9.4, leading=13.4, textColor=INK, spaceAfter=5),
 'cell': ParagraphStyle('cell', fontName='Helvetica', fontSize=8.8, leading=11.6, textColor=INK),
 'cellb':ParagraphStyle('cellb', fontName='Helvetica-Bold', fontSize=8.8, leading=11.6, textColor=INK),
 'msg':  ParagraphStyle('msg', fontName='Courier', fontSize=8.0, leading=10.8, textColor=INK),
}
def esc(t): return html.escape(str(t), quote=False)
def n(x):   return f"{round(x):,}"

flow = []
flow.append(Paragraph('October Side Quests', S['h1']))
flow.append(Paragraph(
  f"What the selection picks today, run against data to {D['asOf']}. "
  f"The real run is {D['questDay']} — this is a preview, not the list.", S['sub']))

s = D['summary']
tot = sum(q['worthGbp'] for q in Q)
coins = sum(q['questCoins'] + q['incentiveCoins'] for q in Q)
newcoins = sum(q['questCoins'] for q in Q)
rows = [['', ''],
  ['Quests', str(len(Q))],
  ['Worth to LEAP if every one lands', f"£{n(tot)}"],
  ['Coins if every one hits', f"{n(coins)}  (£{n(coins*0.01)})"],
  ['   of which new Side Quest coins', f"{n(newcoins)}  (£{n(newcoins*0.01)})"],
  ['   already owed as incentives', f"{n(coins-newcoins)}  (£{n((coins-newcoins)*0.01)})"],
  ['Coaches involved', str(len({q['coachLabel'] for q in Q}))],
  ['Rank-ups / holds', f"{sum(1 for q in Q if q['kind']=='CROSS')} / {sum(1 for q in Q if q['kind']=='HOLD')}"],
]
t = Table([[Paragraph(esc(a), S['cellb'] if i==0 else S['cell']), Paragraph(esc(b), S['cell'])]
           for i,(a,b) in enumerate(rows[1:])], colWidths=[108*mm, 55*mm])
t.setStyle(TableStyle([('LINEBELOW',(0,0),(-1,-2),0.3,RULE),
  ('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),4),
  ('TOPPADDING',(0,0),(-1,-1),3),('BOTTOMPADDING',(0,0),(-1,-1),3),
  ('ROWBACKGROUNDS',(0,0),(-1,-1),[colors.white, colors.HexColor('#fafbfc')])]))
flow += [t, Spacer(1,8)]

# per coach
by = {}
for q in Q: by.setdefault(q['coachLabel'], []).append(q)
flow.append(Paragraph('Who is carrying them', S['h2']))
data = [[Paragraph('Coach', S['cellb']), Paragraph('Quests', S['cellb']), Paragraph('Worth', S['cellb']), Paragraph('Creators', S['cellb'])]]
for k, v in sorted(by.items(), key=lambda x: -len(x[1])):
    data.append([Paragraph(esc(k), S['cell']), Paragraph(str(len(v)), S['cell']),
                 Paragraph(f"£{n(sum(x['worthGbp'] for x in v))}", S['cell']),
                 Paragraph(esc(', '.join('@'+x['username'] for x in v)), S['cell'])])
t = Table(data, colWidths=[24*mm, 16*mm, 18*mm, 105*mm], repeatRows=1)
t.setStyle(TableStyle([('LINEBELOW',(0,0),(-1,0),0.9,INK),('LINEBELOW',(0,1),(-1,-2),0.3,RULE),
  ('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),4),
  ('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),4)]))
flow += [t, Spacer(1,6)]
flow.append(Paragraph(
  'Every quest below is one target, frozen the day it is set. Hitting it pays the incentive '
  'the creator would have earned anyway, plus the Side Quest coins on top, plus a Uni Wheel entry. '
  'Missing it costs them nothing they had.', S['p']))

flow.append(Paragraph('The quests', S['h2']))
for i, q in enumerate(Q, 1):
    stretch = (q['perNight'] / q['formAtSet']) if q['formAtSet'] else None
    tone = '#0b7a43' if (stretch and stretch <= 1.5) else ('#b45309' if (stretch and stretch > 3) else '#15181d')
    head = [
      Paragraph(f"{i}. @{esc(q['username'])} &nbsp;&nbsp;<font color='#5b6572'>"
                f"{esc(q['coachLabel'])}{' · '+esc(q['group']) if q.get('group') else ''}</font>", S['name']),
      Paragraph(f"{'Reach' if q['kind']=='CROSS' else 'Hold'} Tier {q['tier']} "
                f"· worth £{n(q['worthGbp'])} to LEAP "
                f"· {n(q['questCoins'])} quest coins"
                + (f" + {n(q['incentiveCoins'])} incentive" if q['incentiveCoins'] else " (tier pays no incentive)"), S['meta']),
    ]
    facts = [[Paragraph('On now', S['cellb']), Paragraph('Target', S['cellb']),
              Paragraph('To go', S['cellb']), Paragraph('Per night', S['cellb']),
              Paragraph('Doing now', S['cellb']), Paragraph('Stretch', S['cellb'])],
             [Paragraph(n(q['startedAt']), S['cell']), Paragraph(n(q['target']), S['cell']),
              Paragraph(n(q['need']), S['cell']), Paragraph(n(q['perNight']), S['cell']),
              Paragraph(n(q['formAtSet']), S['cell']),
              Paragraph(f"<font color='{tone}'>{stretch:.1f}x</font>" if stretch else '-', S['cell'])]]
    ft = Table(facts, colWidths=[27*mm]*6)
    ft.setStyle(TableStyle([('LINEBELOW',(0,0),(-1,0),0.5,RULE),
      ('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),3),
      ('TOPPADDING',(0,0),(-1,-1),3),('BOTTOMPADDING',(0,0),(-1,-1),3),
      ('BACKGROUND',(0,0),(-1,-1),BOX)]))
    msg = [Paragraph(esc(l).replace(' ','&nbsp;') or '&nbsp;', S['msg']) for l in q['message'].split('\n')]
    mt = Table([[msg]], colWidths=[163*mm])
    mt.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#f7f8fa')),
      ('BOX',(0,0),(-1,-1),0.5,RULE),('LINEBEFORE',(0,0),(0,-1),2.0,ACC),
      ('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),6),
      ('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6)]))
    flow.append(KeepTogether(head + [ft, Spacer(1,4),
      Paragraph('What the coach sends:', S['meta']), mt, Spacer(1,11)]))

def deco(c, d):
    c.saveState(); c.setStrokeColor(RULE); c.setLineWidth(0.5)
    c.line(23*mm, 16*mm, 196*mm, 16*mm)
    c.setFont('Helvetica', 7.4); c.setFillColor(MUTE)
    c.drawString(23*mm, 11*mm, f"LEAP Side Quests — preview on data to {D['asOf']}, real run {D['questDay']}")
    c.drawRightString(196*mm, 11*mm, 'Page %d' % d.page)
    c.restoreState()

doc = BaseDocTemplate(OUT, pagesize=A4, title='October Side Quests', author='LEAP',
                      leftMargin=23*mm, rightMargin=14*mm, topMargin=18*mm, bottomMargin=22*mm)
doc.addPageTemplates([PageTemplate(id='n', frames=[Frame(23*mm, 22*mm, 163*mm, 257*mm, id='f')], onPage=deco)])
doc.build(flow)
print('built', OUT)
