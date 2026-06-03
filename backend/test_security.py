"""Проверка мер защиты: блок опасных загрузок и rate-limit на вход."""
import json, time, io, urllib.request, urllib.error

BASE = 'http://127.0.0.1:8000/api'


def req(method, path, data=None, token=None):
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(BASE + path, data=body, method=method)
    r.add_header('Content-Type', 'application/json')
    if token: r.add_header('Authorization', 'Token ' + token)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {}


def upload(token, filename, content, ctype):
    boundary = '----b0undary'
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f'Content-Type: {ctype}\r\n\r\n'
    ).encode() + content + f'\r\n--{boundary}--\r\n'.encode()
    r = urllib.request.Request(BASE + '/upload', data=body, method='POST')
    r.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
    r.add_header('Authorization', 'Token ' + token)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {}


def check(name, cond):
    print(('  OK  ' if cond else '  FAIL ') + name)
    assert cond, name


sfx = str(int(time.time()))[-6:]
s, r = req('POST', '/register', {'username': 'sec' + sfx, 'password': 'Secret_2024x', 'name': 'Sec'})
token = r['token']

print('Загрузка SVG (должна быть отклонена)')
s, r = upload(token, 'evil.svg', b'<svg onload="alert(1)"></svg>', 'image/svg+xml')
check('SVG отклонён', s == 400)

print('Загрузка HTML (должна быть отклонена)')
s, r = upload(token, 'x.html', b'<script>alert(1)</script>', 'text/html')
check('HTML отклонён', s == 400)

print('Загрузка PNG (должна пройти)')
png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082')
s, r = upload(token, 'ok.png', png, 'image/png')
check('PNG принят', s == 200 and 'url' in r)

print('Rate-limit на вход (>15/мин → 429)')
codes = []
for i in range(20):
    s, _ = req('POST', '/login', {'username': 'sec' + sfx, 'password': 'wrong'})
    codes.append(s)
check('появился 429 (throttle)', 429 in codes)
print('  коды:', codes)

print('\\nЗАЩИТА РАБОТАЕТ ✅')
