"""Проверка модерации-жалоб: без блокировки, жалоба + видимость у админа."""
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


def check(name, cond):
    print(('  OK  ' if cond else '  FAIL ') + name)
    assert cond, name


sfx = str(int(time.time()))[-6:]
PW = 'Secret_2024x'
offender = 'off' + sfx
admin_u = 'adm' + sfx

s, ro = req('POST', '/register', {'username': offender, 'password': PW, 'name': 'Нарушитель'})
to = ro['token']
s, rad = req('POST', '/register', {'username': admin_u, 'password': PW, 'name': 'Админ'})
tad = rad['token']

print('1. Запрещённое сообщение проходит (без блокировки)')
s, saved = req('POST', '/chats', {'type': 'saved'}, token=to)
s, m = req('POST', f'/chats/{saved["id"]}/messages',
           {'type': 'text', 'content': 'продам наркотик, есть закладка'}, token=to)
check('сообщение доставлено (200)', s == 200 and not m.get('banned'))

print('2. Нарушитель НЕ заблокирован — аккаунт жив')
s, r = req('GET', '/me', token=to)
check('аккаунт работает', s == 200 and r['username'] == offender)

print('3. Обычный пользователь НЕ видит жалобы (403)')
s, r = req('GET', '/reports', token=tad)
check('не-админ заблокирован от жалоб', s == 403)

print('4. Делаем админом и проверяем доступ к жалобам')
User.objects.filter(username=admin_u).update(is_staff=True)
s, reports = req('GET', '/reports', token=tad)
check('админ видит список', s == 200 and isinstance(reports, list))
found = [x for x in reports if x['offender'] == offender]
check('жалоба на нарушителя есть', len(found) >= 1)
check('категория = наркотики', any(x['category'] == 'наркотики' for x in found))

print('5. Профиль /me у админа помечен isAdmin')
s, meu = req('GET', '/me', token=tad)
check('isAdmin=true', meu.get('isAdmin') is True)

print('6. Пометка жалобы решённой')
rid = found[0]['id']
s, r = req('POST', f'/reports/{rid}', token=tad)
check('жалоба решена', s == 200 and r.get('resolved'))
s, reports2 = req('GET', '/reports', token=tad)
check('решённая ушла из активных', not any(x['id'] == rid for x in reports2))

print('7. Безобидное сообщение жалобу НЕ создаёт')
before = len(req('GET', '/reports?all=1', token=tad)[1])
req('POST', f'/chats/{saved["id"]}/messages', {'type': 'text', 'content': 'привет, как дела'}, token=to)
after = len(req('GET', '/reports?all=1', token=tad)[1])
check('новых жалоб нет', after == before)

print('\\nМОДЕРАЦИЯ-ЖАЛОБЫ РАБОТАЕТ ✅')
