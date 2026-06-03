"""Быстрый тест API мессенджера через стандартную библиотеку."""
import json
import urllib.request
import urllib.error

BASE = 'http://127.0.0.1:8000/api'


def req(method, path, data=None, token=None):
    url = BASE + path
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, data=body, method=method)
    r.add_header('Content-Type', 'application/json')
    if token:
        r.add_header('Authorization', 'Token ' + token)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def check(name, cond):
    print(('  ✓ ' if cond else '  ✗ ПРОВАЛ: ') + name)
    assert cond, name


print('1. Регистрация двух пользователей')
import time
suffix = str(int(time.time()))[-5:]
ua, ub = 'alice' + suffix, 'bob' + suffix
PW = 'Secret_2024x'
s, ra = req('POST', '/register', {'username': ua, 'password': PW, 'name': 'Алиса', 'phone': '7700' + suffix + '1'})
check('alice зарегистрирована', s == 200 and 'token' in ra)
s, rb = req('POST', '/register', {'username': ub, 'password': PW, 'name': 'Боб', 'phone': '7700' + suffix + '2'})
check('bob зарегистрирован', s == 200 and 'token' in rb)
ta, tb = ra['token'], rb['token']
aid, bid = ra['user']['id'], rb['user']['id']

print('2. Повторная регистрация = ошибка')
s, r = req('POST', '/register', {'username': ua, 'password': PW, 'name': 'X'})
check('дубль юзернейма отклонён', s == 400)

print('2b. Слабый пароль отклоняется')
s, r = req('POST', '/register', {'username': 'weak' + suffix, 'password': '1234', 'name': 'W'})
check('короткий/цифровой пароль отклонён', s == 400)

print('3. Вход')
s, r = req('POST', '/login', {'username': ua, 'password': PW})
check('вход alice ок', s == 200 and ('token' in r))
s, r = req('POST', '/login', {'username': ua, 'password': 'wrong'})
check('неверный пароль отклонён', s == 400)

print('4. /me и обновление профиля')
s, r = req('GET', '/me', token=ta)
check('me работает', s == 200 and r['username'] == ua)
s, r = req('PATCH', '/me', {'bio': 'тестовое био', 'mood': '😎'}, token=ta)
check('профиль обновлён', s == 200 and r['bio'] == 'тестовое био' and r['mood'] == '😎')

print('5. Приватность: до общего чата alice НЕ видит bob в /users')
s, r = req('GET', '/users', token=ta)
check('список не раскрывает чужих', s == 200 and not any(u['username'] == ub for u in r))

print('6. Создание DM alice→bob')
s, dm = req('POST', '/chats', {'type': 'dm', 'withUserId': bid}, token=ta)
check('DM создан', s == 200 and dm['type'] == 'dm')
dm_id = dm['id']
s, r = req('GET', '/users', token=ta)
check('после общего чата alice видит bob', any(u['username'] == ub for u in r))
s, dm2 = req('POST', '/chats', {'type': 'dm', 'withUserId': bid}, token=ta)
check('повторный DM = тот же чат', dm2['id'] == dm_id)

print('7. bob видит этот чат')
s, r = req('GET', '/chats', token=tb)
check('bob видит DM', s == 200 and any(c['id'] == dm_id for c in r))

print('8. Отправка сообщения alice→bob')
s, m = req('POST', f'/chats/{dm_id}/messages', {'type': 'text', 'content': 'Привет, Боб!'}, token=ta)
check('сообщение отправлено', s == 200 and m['content'] == 'Привет, Боб!')
mid = m['id']

print('9. bob получает сообщение через /sync')
s, r = req('GET', '/sync?since=0', token=tb)
check('sync вернул сообщение', s == 200 and any(x['id'] == mid for x in r['messages']))

print('10. Реакция от bob (merge extra)')
s, r = req('PATCH', f'/messages/{mid}', {'extra': {'reactions': {'❤️': [bid]}}}, token=tb)
check('реакция добавлена', s == 200 and r['extra'].get('reactions', {}).get('❤️') == [bid])

print('11. Редактирование своего сообщения (alice)')
s, r = req('PATCH', f'/messages/{mid}', {'content': 'Привет, Боб! (ред.)'}, token=ta)
check('сообщение отредактировано', s == 200 and r['editedAt'] is not None)

print('12. bob НЕ может редактировать чужой текст')
s, r = req('PATCH', f'/messages/{mid}', {'content': 'взлом'}, token=tb)
check('чужая правка запрещена', s == 403)

print('13. Группа')
s, g = req('POST', '/chats', {'type': 'group', 'name': 'Команда', 'memberIds': [bid]}, token=ta)
check('группа создана с участником', s == 200 and g['type'] == 'group' and bid in g['members'])

print('14. Удаление сообщения (alice — автор)')
s, r = req('DELETE', f'/messages/{mid}', token=ta)
check('сообщение удалено', s == 200)
s, r = req('GET', '/sync?since=0', token=tb)
check('удалённого нет в выборке', not any(x['id'] == mid for x in r['messages']))

print('\\nВСЕ ТЕСТЫ ПРОЙДЕНЫ ✅')
