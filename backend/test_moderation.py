"""Проверка модерации: бан+удаление за запрещённый контент, блок возврата."""
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


def check(name, cond):
    print(('  OK  ' if cond else '  FAIL ') + name)
    assert cond, name


sfx = str(int(time.time()))[-6:]
PW = 'Secret_2024x'
bad_user = 'bad' + sfx

# регистрируем нарушителя и жертву (для общего чата)
s, ra = req('POST', '/register', {'username': bad_user, 'password': PW, 'name': 'Нарушитель'})
ta = ra['token']
s, rb = req('POST', '/register', {'username': 'victim' + sfx, 'password': PW, 'name': 'Сосед'})
tb = rb['token']; bid = rb['user']['id']

print('1. Обычное сообщение проходит')
s, dm = req('POST', '/chats', {'type': 'dm', 'withUserId': bid}, token=ta)
s, m = req('POST', f'/chats/{dm["id"]}/messages', {'type': 'text', 'content': 'Привет, как дела?'}, token=ta)
check('обычное сообщение принято', s == 200)

print('2. Запрещённое сообщение → бан + удаление')
s, m = req('POST', f'/chats/{dm["id"]}/messages',
           {'type': 'text', 'content': 'Куплю наркотик, есть закладка?'}, token=ta)
check('сообщение заблокировано (403 banned)', s == 403 and m.get('banned'))

print('3. Аккаунт удалён — токен больше не работает')
s, r = req('GET', '/me', token=ta)
check('старый токен мёртв', s == 401)

print('4. Повторный вход забанен')
s, r = req('POST', '/login', {'username': bad_user, 'password': PW}, token=None)
check('вход заблокирован', s == 403 and r.get('banned'))

print('5. Повторная регистрация того же юзернейма забанена')
s, r = req('POST', '/register', {'username': bad_user, 'password': PW, 'name': 'X'})
check('регистрация заблокирована', s == 403 and r.get('banned'))

print('6. Запрещённое слово в имени при регистрации отклоняется')
s, r = req('POST', '/register', {'username': 'okname' + sfx, 'password': PW, 'name': 'террорист готовит теракт'})
check('недопустимое имя отклонено', s == 403)

print('7. Безобидное сообщение у жертвы по-прежнему работает')
s, dm2 = req('POST', '/chats', {'type': 'saved'}, token=tb)
s, m = req('POST', f'/chats/{dm2["id"]}/messages', {'type': 'text', 'content': 'мои заметки'}, token=tb)
check('жертва не задета', s == 200)

print('\\nМОДЕРАЦИЯ РАБОТАЕТ ✅')
