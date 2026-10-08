import re, html
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Table, TableStyle, KeepTogether, PageBreak)

import sys
# build-briefing-pdf.py <source.md> [out.pdf] [footer text]
SRC = sys.argv[1] if len(sys.argv) > 1 else '/home/user/-leap-relay/creator-health/docs/LEAP-New-Requirements-Briefing.md'
OUT = sys.argv[2] if len(sys.argv) > 2 else SRC.rsplit('.', 1)[0] + '.pdf'
FOOT = sys.argv[3] if len(sys.argv) > 3 else 'LEAP — new creator requirements, staff briefing'
INK, MUTE, RULE, ACC = colors.HexColor('#15181d'), colors.HexColor('#5b6572'), colors.HexColor('#dfe3e8'), colors.HexColor('#0f5ad6')
BOX = colors.HexColor('#f4f6f9')

def esc(t):
    t = html.escape(t, quote=False)
    t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
    t = re.sub(r'(?<!\w)`([^`]+)`(?!\w)', r'<font face="Courier">\1</font>', t)
    return t

S = {
 'h1':   ParagraphStyle('h1', fontName='Helvetica-Bold', fontSize=21, leading=25, textColor=INK, spaceAfter=2),
 'sub':  ParagraphStyle('sub', fontName='Helvetica', fontSize=11.5, leading=15, textColor=MUTE, spaceAfter=14),
 'h2':   ParagraphStyle('h2', fontName='Helvetica-Bold', fontSize=13, leading=16, textColor=INK, spaceBefore=16, spaceAfter=6),
 'h3':   ParagraphStyle('h3', fontName='Helvetica-Bold', fontSize=10.5, leading=13, textColor=ACC, spaceBefore=10, spaceAfter=4),
 'p':    ParagraphStyle('p', fontName='Helvetica', fontSize=9.6, leading=14, textColor=INK, spaceAfter=6),
 'li':   ParagraphStyle('li', fontName='Helvetica', fontSize=9.6, leading=14, textColor=INK,
                        leftIndent=11, bulletIndent=2, spaceAfter=3),
 'quote':ParagraphStyle('quote', fontName='Helvetica', fontSize=9.4, leading=13.6, textColor=INK,
                        leftIndent=9, rightIndent=6, spaceAfter=3),
 'code': ParagraphStyle('code', fontName='Courier', fontSize=8.0, leading=10.4, textColor=INK),
 'cell': ParagraphStyle('cell', fontName='Helvetica', fontSize=8.8, leading=12, textColor=INK),
 'cellb':ParagraphStyle('cellb', fontName='Helvetica-Bold', fontSize=8.8, leading=12, textColor=INK),
}

def _merge(lines):
    # join consecutive lines while a ** pair is still open, so bold can wrap
    out, buf = [], ''
    for l in lines:
        buf = (buf + ' ' + l).strip() if buf else l
        if buf.count('**') % 2 == 0:
            out.append(buf); buf = ''
    if buf: out.append(buf)
    return out

def quote_block(lines):
    inner = [Paragraph(esc(l), S['quote']) for l in _merge(lines) if l.strip()]
    t = Table([[inner]], colWidths=[163*mm])
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),BOX),
        ('LINEBEFORE',(0,0),(0,-1),2.0,ACC),
        ('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),
        ('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)]))
    return t

def code_block(lines):
    inner = [Paragraph(html.escape(l).replace(' ','&nbsp;'), S['code']) for l in lines]
    t = Table([[inner]], colWidths=[163*mm])
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#f7f8fa')),
        ('BOX',(0,0),(-1,-1),0.5,RULE),
        ('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),6),
        ('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)]))
    return t

def md_table(rows):
    head, body = rows[0], rows[2:]
    data = [[Paragraph(esc(c), S['cellb']) for c in head]] + \
           [[Paragraph(esc(c), S['cell']) for c in r] for r in body]
    n = len(head)
    first = 62*mm if n <= 3 else 44*mm
    w = [first] + [(163*mm-first)/(n-1)]*(n-1)
    t = Table(data, colWidths=w, repeatRows=1)
    t.setStyle(TableStyle([
        ('LINEBELOW',(0,0),(-1,0),0.9,INK),
        ('LINEBELOW',(0,1),(-1,-2),0.3,RULE),
        ('VALIGN',(0,0),(-1,-1),'TOP'),
        ('LEFTPADDING',(0,0),(-1,-1),4),('RIGHTPADDING',(0,0),(-1,-1),4),
        ('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),4),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, colors.HexColor('#fafbfc')])]))
    return t

src = open(SRC).read().split('\n')
flow, i = [], 0
while i < len(src):
    ln = src[i]
    if ln.startswith('# '):
        flow.append(Paragraph(esc(ln[2:]), S['h1']))
    elif ln.startswith('## ') and i < 4:
        flow.append(Paragraph(esc(ln[3:]), S['sub']))
    elif ln.startswith('## '):
        flow.append(Paragraph(esc(ln[3:]), S['h2']))
    elif ln.startswith('### '):
        flow.append(Paragraph(esc(ln[4:]), S['h3']))
    elif ln.startswith('```'):
        blk=[]; i+=1
        while i < len(src) and not src[i].startswith('```'):
            blk.append(src[i]); i+=1
        flow.append(code_block(blk))
        flow.append(Spacer(1,5))
    elif ln.startswith('> '):
        blk=[]
        while i < len(src) and src[i].startswith('>'):
            blk.append(src[i].lstrip('>').strip()); i+=1
        i-=1
        flow.append(quote_block(blk)); flow.append(Spacer(1,5))
    elif ln.startswith('|'):
        rows=[]
        while i < len(src) and src[i].startswith('|'):
            rows.append([c.strip() for c in src[i].strip('|').split('|')]); i+=1
        i-=1
        flow.append(md_table(rows)); flow.append(Spacer(1,6))
    elif re.match(r'^[-*] ', ln):
        flow.append(Paragraph(esc(ln[2:]), S['li'], bulletText='•'))
    elif re.match(r'^\d+\. ', ln):
        n, rest = ln.split('. ', 1)
        flow.append(Paragraph(esc(rest), S['li'], bulletText=n+'.'))
    elif ln.strip() == '---':
        pass
    elif ln.strip():
        # gather the whole wrapped paragraph, so bold can span lines and the
        # text sets as one block rather than one paragraph per source line
        buf = [ln.strip()]
        while (i+1 < len(src) and src[i+1].strip()
               and not re.match(r'^(#|>|\||```|[-*] |\d+\. |---)', src[i+1])):
            i += 1; buf.append(src[i].strip())
        flow.append(Paragraph(esc(' '.join(buf)), S['p']))
    i += 1

def deco(c, d):
    c.saveState()
    c.setStrokeColor(RULE); c.setLineWidth(0.5)
    c.line(23*mm, 16*mm, 196*mm, 16*mm)
    c.setFont('Helvetica', 7.4); c.setFillColor(MUTE)
    c.drawString(23*mm, 11*mm, FOOT)
    c.drawRightString(196*mm, 11*mm, 'Page %d' % d.page)
    c.restoreState()

doc = BaseDocTemplate(OUT, pagesize=A4, title=SRC.rsplit('/',1)[-1].rsplit('.',1)[0].replace('-',' '),
                      author='LEAP', leftMargin=23*mm, rightMargin=14*mm,
                      topMargin=18*mm, bottomMargin=22*mm)
doc.addPageTemplates([PageTemplate(id='n',
    frames=[Frame(23*mm, 22*mm, 163*mm, 257*mm, id='f')], onPage=deco)])
doc.build(flow)
print('built', OUT)
