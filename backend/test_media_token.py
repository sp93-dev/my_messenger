"""Проверка защиты медиа (доступ только с токеном) и истечения токена."""
import json, time, urllib.request, urllib.error

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


def upload_png(token):
    boundary = '----b'
    png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082')
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n'
            f'Content-Type: image/png\r\n\r\n').encode() + png + f'\r\n--{boundary}--\r\n'.encode()
    r = urllib.request.Request(BASE + '/upload', data=body, method='POST')
    r.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
    r.add_header('Authorization', 'Token ' + token)
    with urllib.request.urlopen(r, timeout=10) as resp:
        return json.loads(resp.read().decode())


def get_raw(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def check(name, cond):
    print(('  OK  ' if cond else '  FAIL ') + name)
    assert cond, name


sfx = str(int(time.time()))[-6:]
s, r = req('POST', '/register', {'username': 'med' + sfx, 'password': 'Secret_2024x', 'name': 'M'})
token = r['token']

up = upload_png(token)
url = up['url']            # чистый URL без токена
print('URL:', url)

print('Доступ к медиа без токена → запрещён')
check('403 без токена', get_raw(url) == 403)

print('Доступ с валидным токеном → разрешён')
sep = '&' if '?' in url else '?'
check('200 с токеном', get_raw(url + sep + 't=' + token) == 200)

print('Доступ с неверным токеном → запрещён')
check('403 с мусорным токеном', get_raw(url + sep + 't=bogus123') == 403)

print('Истёкший/удалённый токен → 401 на API')
# имитируем удаление токена на сервере через смену пароля (токен пересоздаётся)
s, r = req('PATCH', '/me', {'password': 'NewSecret_99z'}, token=token)
check('пароль сменён', s == 200)
s, r = req('GET', '/me', token=token)   # старый токен теперь недействителен
check('старый токен отклонён (401)', s == 401)

print('\\nМЕДИА И ТОКЕНЫ ЗАЩИЩЕНЫ ✅')
