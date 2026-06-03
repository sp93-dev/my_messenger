"""Проверка приватности: поиск по юзернейму/телефону, нет полного списка."""
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
ua, ub = 'anna' + sfx, 'boris' + sfx
phone_a = '7900' + sfx + '22'
phone_b = '7900' + sfx + '11'
s, ra = req('POST', '/register', {'username': ua, 'password': PW, 'name': 'Анна', 'phone': phone_a}); ta = ra['token']
s, rb = req('POST', '/register', {'username': ub, 'password': PW, 'name': 'Борис', 'phone': phone_b}); tb = rb['token']; bid = rb['user']['id']

print('0. Телефон обязателен при регистрации')
s, r = req('POST', '/register', {'username': 'nophone' + sfx, 'password': PW, 'name': 'Без телефона'})
check('регистрация без телефона отклонена', s == 400)

print('0b. Вход по номеру телефона работает')
s, r = req('POST', '/login', {'username': phone_b, 'password': PW})
check('вход по телефону (поле username)', s == 200 and 'token' in r)
s, r = req('POST', '/login', {'phone': '+' + phone_b, 'password': PW})
check('вход по телефону (поле phone)', s == 200 and 'token' in r)
s, r = req('POST', '/login', {'username': ub, 'password': PW})
check('вход по юзернейму всё ещё работает', s == 200 and 'token' in r)

print('1. Телефон сохранён и виден только себе')
s, meb = req('GET', '/me', token=tb)
check('у себя телефон есть', meb.get('phone') == phone_b)

print('2. Нет полного списка: /sync у Анны не содержит Бориса (нет общих чатов)')
s, sync = req('GET', '/sync?since=0', token=ta)
unames = [u['username'] for u in sync['users']]
check('Борис не виден в users', ub not in unames)
check('телефон чужого не светится', all(not u.get('phone') for u in sync['users'] if u['username'] != ua))

print('3. Поиск по юзернейму находит')
s, found = req('GET', f'/users/search?q={ub}', token=ta)
check('найден по юзернейму', any(u['username'] == ub for u in found))

print('4. Поиск по телефону находит')
s, found = req('GET', f'/users/search?q=%2B{phone_b}', token=ta)
check('найден по телефону', any(u['username'] == ub for u in found))

print('5. Короткий запрос ничего не выдаёт (нет перечисления)')
s, found = req('GET', '/users/search?q=an', token=ta)
check('меньше 3 символов = пусто', found == [])

print('6. Несуществующий = пусто')
s, found = req('GET', f'/users/search?q=nikoho{sfx}', token=ta)
check('никого не найдено', found == [])

print('7. Дубликат телефона при регистрации отклонён')
s, r = req('POST', '/register', {'username': 'carl' + sfx, 'password': PW, 'name': 'Карл', 'phone': phone_b})
check('телефон-дубликат отклонён', s == 400)

print('8. После создания чата собеседник появляется в /sync')
# у Бориса должен быть ключ E2E (в реальности появляется при первом входе в клиент)
req('PATCH', '/me', {'pubkey': 'dGVzdC1wdWJrZXk='}, token=tb)
s, dm = req('POST', '/chats', {'type': 'dm', 'withUserId': bid, 'secret': True}, token=ta)
check('секретный DM создан', dm.get('secret') is True)
s, sync = req('GET', '/sync?since=0', token=ta)
check('теперь Борис виден', any(u['username'] == ub for u in sync['users']))

print('\\nПРИВАТНОСТЬ И ПОИСК РАБОТАЮТ ✅')
