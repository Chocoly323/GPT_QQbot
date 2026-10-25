"""Bounded, read-only extraction; never execute document macros or links."""
import sys, json, zipfile, pathlib, subprocess, tempfile, resource, warnings
import xml.etree.ElementTree as ET
import posixpath
resource.setrlimit(resource.RLIMIT_AS, (768 * 1024**2, 768 * 1024**2))
resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024**2, 32 * 1024**2))
LIMIT = 60000
path = pathlib.Path(sys.argv[1])
ext = sys.argv[2]

def xml(z, name):
    data = z.read(name)
    if b'<!DOCTYPE' in data or b'<!ENTITY' in data:
        raise ValueError('XML entities are unsupported')
    return ET.fromstring(data)

def extract():
    if ext in ('.jpg', '.jpeg', '.png', '.webp'):
        from PIL import Image
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        Image.MAX_IMAGE_PIXELS = 25000000
        with Image.open(path) as im:
            if im.format not in ('JPEG', 'PNG', 'WEBP'):
                raise ValueError('Unsupported image encoding')
            im.load()
            im.thumbnail((2048, 2048))
            im.convert('RGB').save(sys.argv[3], 'PNG')
        return ''
    if ext in ('.txt', '.md', '.csv'):
        raw = path.read_bytes()
        try: text = raw.decode('utf-8-sig')
        except UnicodeDecodeError: text = raw.decode('gb18030')
        if '\x00' in text: raise ValueError('Not a text document')
        return text
    if ext == '.pdf':
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / 'text'
            subprocess.run(['/usr/bin/pdftotext', '-f', '1', '-l', '200', '-layout', str(path), str(out)], check=True, timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            text = out.open(encoding='utf-8').read(LIMIT + 1)
            return text or '[未提取到文字：可能为扫描版 PDF；当前不支持 PDF OCR。]'
    with zipfile.ZipFile(path) as z:
        if len(z.infolist()) > 5000 or sum(i.file_size for i in z.infolist()) > 64 * 1024**2:
            raise ValueError('Document expands beyond limit')
        if ext == '.docx':
            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            return '\n'.join(''.join(p.itertext()) for p in xml(z, 'word/document.xml').findall('.//w:p', ns))
        ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        shared = []
        if 'xl/sharedStrings.xml' in z.namelist():
            shared = [''.join(n.itertext()) for n in xml(z, 'xl/sharedStrings.xml')]
        workbook = xml(z, 'xl/workbook.xml')
        relationships = xml(z, 'xl/_rels/workbook.xml.rels')
        targets = {r.get('Id'): r.get('Target') for r in relationships if r.get('TargetMode') != 'External'}
        sheets = []
        for sheet in workbook.findall('.//s:sheet', ns):
            target = targets.get(sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'), '')
            member = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
            if not member.startswith('xl/worksheets/') or member not in z.namelist():
                raise ValueError('Invalid worksheet relationship')
            sheets.append((sheet.get('name', ''), member))
        parts = []
        for name, sheet in sheets:
            parts.append('[工作表 ' + name + ']')
            for row in xml(z, sheet).findall('.//s:row', ns):
                cells = []
                for cell in row.findall('s:c', ns):
                    val = cell.findtext('s:v', '', ns)
                    if cell.get('t') == 's': val = shared[int(val)] if val else ''
                    elif cell.get('t') == 'inlineStr': val = ''.join(cell.find('s:is', ns).itertext())
                    formula = cell.findtext('s:f', '', ns)
                    cells.append(cell.get('r', '') + '=' + val + (' [公式:' + formula + ']' if formula else ''))
                parts.append('\t'.join(cells))
                if sum(map(len, parts)) > LIMIT: return '\n'.join(parts)
        return '\n'.join(parts)
try:
    result = extract()
    print(json.dumps({'text': result[:LIMIT], 'truncated': len(result) > LIMIT}, ensure_ascii=False))
except Exception as error:
    print(type(error).__name__, file=sys.stderr)
    sys.exit(1)
