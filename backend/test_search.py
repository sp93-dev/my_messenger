"""Поиск контактов по вхождению символов в юзернейм + частичный телефон."""
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
# у всех юзернеймов есть общий кусок "arin"
names = {
    'marina':   'marina' + sfx,
    'marinka':  'marinka' + sfx,
    'karina':   'karina' + sfx,
    'dmitry':   'dmitry' + sfx,   # без "arin"
}
phones = {}
tokens = {}
ids = {}
i = 0
for key, uname in names.items():
    ph = '7960' + sfx + str(i)
    phones[key] = ph
    s, r = req('POST', '/register', {'username': uname, 'password': PW, 'name': key, 'phone': ph})
    assert s == 200, (uname, r)
    tokens[key] = r['token']; ids[key] = r['user']['id']
    i += 1

# ищем от лица dmitry
t = tokens['dmitry']


def usernames(q):
    s, r = req('GET', '/users/search?q=' + urllib.parse.quote(q), token=t)
    return [u['username'] for u in r]


import urllib.parse

print('1. Поиск по вхождению "arin" находит всех, у кого это в юзернейме')
got = usernames('arin')
check('marina найдена', names['marina'] in got)
check('marinka найдена', names['marinka'] in got)
check('karina найдена', names['karina'] in got)
check('dmitry НЕ попал (нет "arin")', names['dmitry'] not in got)

print('2. Поиск по части "marin" находит только marina/marinka')
got = usernames('marin')
check('marina найдена', names['marina'] in got)
check('marinka найдена', names['marinka'] in got)
check('karina НЕ найдена', names['karina'] not in got)

print('3. Точное совпадение стоит первым в списке')
got = usernames(names['karina'])
check('karina есть и первой', got and got[0] == names['karina'])

print('4. С ведущим @ тоже ищет по вхождению')
got = usernames('@marin')
check('@marin находит marina', names['marina'] in got)

print('5. Меньше 3 символов — пусто (без перечисления всех)')
s, r = req('GET', '/users/search?q=ma', token=t)
check('2 символа = пусто', r == [])

print('6. Частичный номер телефона тоже находит')
partial = phones['marina'][:8]
got = usernames(partial)
check('по части номера нашёлся владелец', names['marina'] in got)

print('\\nПОИСК ПО ВХОЖДЕНИЮ РАБОТАЕТ OK')
