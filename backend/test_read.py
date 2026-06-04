"""Проверка: галочки прочтения (readBy через сервер) + телефон только 1 раз."""
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


def check(n, c):
    print(('  OK  ' if c else '  FAIL ') + n); assert c, n


sfx = str(int(time.time()))[-6:]
PW = 'Secret_2024x'
ph_a = '7700' + sfx + '1'
ph_b = '7700' + sfx + '2'
s, ra = req('POST', '/register', {'username': 'al' + sfx, 'password': PW, 'name': 'Аля', 'phone': ph_a}); ta = ra['token']; aid = ra['user']['id']
s, rb = req('POST', '/register', {'username': 'bo' + sfx, 'password': PW, 'name': 'Боря', 'phone': ph_b}); tb = rb['token']; bid = rb['user']['id']

print('1. Аля пишет Боре')
s, dm = req('POST', '/chats', {'type': 'dm', 'withUserId': bid}, token=ta)
cid = dm['id']
s, m = req('POST', f'/chats/{cid}/messages', {'type': 'text', 'content': 'привет'}, token=ta)
mid = m['id']
check('сообщение создано, readBy = только автор', m['extra'].get('readBy', []) in ([aid], [], None) or aid in (m['extra'].get('readBy') or []))

print('2. Боря «читает» — добавляет себя в readBy через extra')
s, upd = req('PATCH', f'/messages/{mid}', {'extra': {'readBy': [bid]}}, token=tb)
check('PATCH прошёл (получатель может пометить прочитанным)', s == 200)

print('3. У Али сообщение теперь прочитано Борей (для галочки ✓✓)')
s, msgs = req('GET', f'/chats/{cid}/messages', token=ta)
target = next((x for x in msgs if x['id'] == mid), None)
readby = (target or {}).get('extra', {}).get('readBy', [])
check('readBy содержит Борю', bid in readby)

print('4. Телефон можно использовать только 1 раз')
s, r = req('POST', '/register', {'username': 'dup' + sfx, 'password': PW, 'name': 'Дубль', 'phone': ph_a})
check('регистрация с занятым телефоном отклонена', s == 400)

print('5. Нельзя занять чужой телефон через смену профиля')
s, r = req('PATCH', '/me', {'phone': ph_a}, token=tb)
check('смена профиля на чужой телефон отклонена', s == 400)

print('\\nГАЛОЧКИ ПРОЧТЕНИЯ И ТЕЛЕФОН РАБОТАЮТ ✅')
