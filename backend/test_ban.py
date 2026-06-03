"""Проверка ручного бана админом."""
import os, json, time, urllib.request, urllib.error
import django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'server.settings')
django.setup()
from django.contrib.auth.models import User  # noqa: E402

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
offender, admin_u = 'bad' + sfx, 'adm' + sfx
s, ro = req('POST', '/register', {'username': offender, 'password': PW, 'name': 'Плохой'}); to = ro['token']; oid = ro['user']['id']
s, ra = req('POST', '/register', {'username': admin_u, 'password': PW, 'name': 'Админ'}); tad = ra['token']
User.objects.filter(username=admin_u).update(is_staff=True)

print('1. До бана нарушитель работает')
s, r = req('GET', '/me', token=to); check('аккаунт активен', s == 200)

print('2. Не-админ не может банить')
s, r = req('POST', '/moderation/ban', {'userId': oid, 'ban': True}, token=to)
check('обычный юзер не банит (403)', s == 403)

print('3. Админ банит нарушителя')
s, r = req('POST', '/moderation/ban', {'userId': oid, 'ban': True}, token=tad)
check('бан выполнен', s == 200 and r.get('banned'))

print('4. Токен забаненного больше не работает')
s, r = req('GET', '/me', token=to); check('сессия вышиблена (401)', s == 401)

print('5. Вход забаненного отклонён')
s, r = req('POST', '/login', {'username': offender, 'password': PW})
check('вход заблокирован', s == 403 and r.get('banned'))

print('6. Разбан возвращает доступ')
s, r = req('POST', '/moderation/ban', {'userId': oid, 'ban': False}, token=tad)
check('разбан выполнен', s == 200)
s, r = req('POST', '/login', {'username': offender, 'password': PW})
check('вход снова работает', s == 200 and 'token' in r)

print('7. Админа забанить нельзя')
s, ra2 = req('POST', '/register', {'username': 'adm2' + sfx, 'password': PW, 'name': 'A2'})
User.objects.filter(username='adm2' + sfx).update(is_staff=True)
s, r = req('POST', '/moderation/ban', {'userId': ra2['user']['id'], 'ban': True}, token=tad)
check('нельзя банить админа', s == 400)

print('\\nРУЧНОЙ БАН РАБОТАЕТ ✅')
