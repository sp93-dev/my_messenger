"""API мессенджера: авторизация, пользователи, чаты, сообщения, синхронизация."""
import os
import re
import uuid
from datetime import datetime, timezone as dt_timezone
from django.conf import settings
from django.core.files.storage import default_storage
from django.contrib.auth.models import User
from django.contrib.auth import authenticate
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjValidationError
from django.db.models import Q
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.authtoken.models import Token
from rest_framework import status

from .models import Profile, Chat, Message, Story, Report
from .serializers import user_public, message_public, chat_public, story_public, report_public
from .notify import notify_users, chat_member_ids
from .throttles import AuthRateThrottle
from .moderation import find_banned, get_client_ip


def staff_ids():
    return list(User.objects.filter(is_staff=True).values_list('id', flat=True))


def norm_phone(s):
    return re.sub(r'\D', '', s or '')


def related_users(user):
    """Пользователи, с которыми есть общие чаты (+ сам пользователь).
    Полный список платформы НЕ раскрывается."""
    my_chats = Chat.objects.filter(members=user).values_list('id', flat=True)
    qs = User.objects.filter(chats__id__in=list(my_chats)).distinct()
    ids = set(qs.values_list('id', flat=True))
    ids.add(user.id)
    return User.objects.filter(id__in=ids).select_related('profile')


def create_report(user, category, term, content, context='message', chat_id=''):
    """Создаёт жалобу для модерации и уведомляет админов (без блокировки)."""
    r = Report.objects.create(
        offender=user, offender_username=getattr(user, 'username', ''),
        category=category, term=term[:120], content=(content or '')[:1000],
        context=context, chat_id=chat_id or '',
    )
    sids = staff_ids()
    if sids:
        notify_users(sids, {'type': 'report', 'report': report_public(r)})
    return r

# Запрещённые к загрузке расширения (исполняемые/скриптовые → риск XSS и malware)
BLOCKED_UPLOAD_EXT = {
    '.svg', '.html', '.htm', '.xhtml', '.xml', '.js', '.mjs', '.mhtml',
    '.swf', '.exe', '.bat', '.cmd', '.sh', '.com', '.scr', '.jar', '.msi', '.php', '.phtml',
}


def check_password_strength(password):
    """Возвращает текст ошибки или None."""
    try:
        validate_password(password)
        return None
    except DjValidationError as e:
        return ' '.join(e.messages)


def touch_presence(user):
    """Обновляет last_seen (онлайн-статус)."""
    Profile.objects.filter(user=user).update(last_seen=timezone.now())


def ms_to_dt(ms):
    try:
        return datetime.fromtimestamp(int(ms) / 1000, tz=dt_timezone.utc)
    except (ValueError, TypeError):
        return datetime.fromtimestamp(0, tz=dt_timezone.utc)


# ============ АВТОРИЗАЦИЯ ============
@api_view(['POST'])
@permission_classes([AllowAny])
@throttle_classes([AuthRateThrottle])
def register(request):
    username = (request.data.get('username') or '').strip()
    password = request.data.get('password') or ''
    name = (request.data.get('name') or '').strip() or username
    if not username or len(username) < 3:
        return Response({'error': 'Юзернейм минимум 3 символа'}, status=400)
    if not all(c.isalnum() or c in '_.' for c in username):
        return Response({'error': 'Юзернейм: только латиница, цифры, _ и .'}, status=400)
    pw_err = check_password_strength(password)
    if pw_err:
        return Response({'error': pw_err}, status=400)
    if User.objects.filter(username__iexact=username).exists():
        return Response({'error': 'Этот юзернейм уже занят'}, status=400)
    phone = norm_phone(request.data.get('phone'))
    if not phone or len(phone) < 7:
        return Response({'error': 'Укажите номер телефона (минимум 7 цифр)'}, status=400)
    if Profile.objects.filter(phone=phone).exists():
        return Response({'error': 'Этот номер телефона уже используется'}, status=400)
    user = User.objects.create_user(username=username, password=password)
    Profile.objects.create(user=user, name=name, phone=phone)
    token, _ = Token.objects.get_or_create(user=user)
    touch_presence(user)
    # без блокировки: если в имени запрещённое — заводим жалобу админу
    hit = find_banned(name) or find_banned(username)
    if hit:
        create_report(user, hit[0], hit[1], 'имя/юзернейм: ' + name + ' / @' + username, context='profile')
    return Response({'token': token.key, 'user': user_public(user)})


@api_view(['POST'])
@permission_classes([AllowAny])
@throttle_classes([AuthRateThrottle])
def login(request):
    # идентификатор: юзернейм ИЛИ номер телефона
    ident = (request.data.get('username') or request.data.get('phone') or '').strip()
    password = request.data.get('password') or ''
    real = None
    # сначала пробуем как юзернейм (без учёта регистра)
    try:
        real = User.objects.get(username__iexact=ident)
    except User.DoesNotExist:
        # затем как номер телефона
        digits = norm_phone(ident)
        if digits and len(digits) >= 7:
            real = (User.objects.filter(profile__phone=digits)
                    .select_related('profile').first())
    if real is None:
        return Response({'error': 'Неверный логин или пароль'}, status=400)
    if not real.is_active:
        return Response({'error': 'Аккаунт заблокирован администратором.', 'banned': True}, status=403)
    user = authenticate(username=real.username, password=password)
    if not user:
        return Response({'error': 'Неверный логин или пароль'}, status=400)
    token, _ = Token.objects.get_or_create(user=user)
    touch_presence(user)
    return Response({'token': token.key, 'user': user_public(user)})


@api_view(['POST'])
def logout(request):
    touch_presence(request.user)
    # помечаем оффлайн (last_seen в прошлое)
    Profile.objects.filter(user=request.user).update(
        last_seen=timezone.now() - timezone.timedelta(seconds=120)
    )
    return Response({'ok': True})


# ============ ПРОФИЛЬ / ПОЛЬЗОВАТЕЛИ ============
@api_view(['GET', 'PATCH'])
def me(request):
    user = request.user
    profile, _ = Profile.objects.get_or_create(user=user, defaults={'name': user.username})
    if request.method == 'GET':
        touch_presence(user)
        return Response(user_public(user, include_phone=True))
    # PATCH — обновление профиля
    d = request.data
    if 'phone' in d:
        phone = norm_phone(d.get('phone'))
        if phone and len(phone) < 7:
            return Response({'error': 'Некорректный номер телефона'}, status=400)
        if phone and Profile.objects.filter(phone=phone).exclude(user=user).exists():
            return Response({'error': 'Этот номер уже используется'}, status=400)
        profile.phone = phone
    # модерация имени/био/статуса — без блокировки, заводим жалобу админу
    scan = ' '.join(str(d.get(k, '')) for k in ('name', 'bio', 'status', 'username', 'vipTag'))
    hit = find_banned(scan)
    if hit:
        create_report(user, hit[0], hit[1], 'профиль: ' + scan.strip(), context='profile')
    if 'name' in d and d['name'].strip():
        profile.name = d['name'].strip()[:64]
    if 'username' in d:
        new_un = (d['username'] or '').strip()
        if new_un and new_un.lower() != user.username.lower():
            if not all(c.isalnum() or c in '_.' for c in new_un) or len(new_un) < 3:
                return Response({'error': 'Некорректный юзернейм'}, status=400)
            if User.objects.filter(username__iexact=new_un).exclude(id=user.id).exists():
                return Response({'error': 'Юзернейм уже занят'}, status=400)
            user.username = new_un
            user.save()
    for f_api, f_model, lim in [
        ('avatar', 'avatar', 2_000_000), ('bio', 'bio', 200),
        ('status', 'status', 100), ('mood', 'mood', 8), ('vipTag', 'vip_tag', 12),
        ('pubkey', 'pubkey', 5000),
    ]:
        if f_api in d:
            setattr(profile, f_model, (d[f_api] or '')[:lim])
    if 'isVip' in d:
        profile.is_vip = bool(d['isVip'])
    if d.get('password'):
        pw_err = check_password_strength(d['password'])
        if pw_err:
            return Response({'error': pw_err}, status=400)
        user.set_password(d['password'])
        user.save()
        Token.objects.filter(user=user).delete()
        Token.objects.create(user=user)
    profile.save()
    return Response(user_public(user, include_phone=True))


@api_view(['GET'])
def users_list(request):
    # Только связанные пользователи (с кем есть общие чаты), без раскрытия всей платформы
    touch_presence(request.user)
    qs = related_users(request.user).exclude(id=request.user.id)
    return Response([user_public(u) for u in qs])


@api_view(['GET'])
def users_search(request):
    """Приватный поиск: по части юзернейма ИЛИ номеру телефона. Без полного списка.
    Точные совпадения по юзернейму показываются первыми, затем — по вхождению."""
    q = (request.query_params.get('q') or '').strip()
    if len(q) < 3:
        return Response([])
    me_id = request.user.id
    results = []
    seen = set()

    def add(u):
        if u.id not in seen and u.id != me_id:
            seen.add(u.id); results.append(u)

    # юзернейм можно вводить с ведущим @
    uname_q = q.lstrip('@').strip()
    if uname_q:
        # 1) точное совпадение — в начало списка
        for u in (User.objects.filter(username__iexact=uname_q)
                  .exclude(id=me_id).select_related('profile')[:5]):
            add(u)
        # 2) совпадение по вхождению введённых символов
        for u in (User.objects.filter(username__icontains=uname_q)
                  .exclude(id=me_id).select_related('profile').order_by('username')[:25]):
            add(u)

    # совпадение по номеру телефона (по введённым цифрам, можно частично)
    digits = norm_phone(q)
    if len(digits) >= 4:
        for u in (User.objects.filter(profile__phone__contains=digits)
                  .exclude(id=me_id).select_related('profile')[:15]):
            add(u)

    return Response([user_public(u) for u in results[:25]])


@api_view(['POST'])
def presence(request):
    touch_presence(request.user)
    return Response({'ok': True})


@api_view(['POST'])
def typing(request, chat_id):
    """Сообщает другим участникам чата, что пользователь печатает (через WebSocket)."""
    user = request.user
    try:
        c = Chat.objects.get(id=chat_id, members=user)
    except Chat.DoesNotExist:
        return Response({'error': 'Чат не найден'}, status=404)
    try:
        name = user.profile.name or user.username
    except Exception:
        name = user.username
    others = [uid for uid in chat_member_ids(c) if uid != user.id]
    notify_users(others, {'type': 'typing', 'chatId': c.id,
                          'userId': str(user.id), 'name': name})
    return Response({'ok': True})


# ============ ЧАТЫ ============
@api_view(['GET', 'POST'])
def chats(request):
    user = request.user
    touch_presence(user)
    if request.method == 'GET':
        my = Chat.objects.filter(members=user).prefetch_related('members')
        return Response([chat_public(c) for c in my])

    d = request.data
    ctype = d.get('type', 'dm')

    if ctype == 'saved':
        existing = Chat.objects.filter(type='saved', members=user).first()
        if existing:
            return Response(chat_public(existing))
        c = Chat.objects.create(type='saved', name='Избранное', owner=user)
        c.members.add(user)
        return Response(chat_public(c))

    if ctype == 'dm':
        other_id = d.get('withUserId')
        secret = bool(d.get('secret'))
        try:
            other = User.objects.get(id=other_id)
        except (User.DoesNotExist, ValueError, TypeError):
            return Response({'error': 'Пользователь не найден'}, status=404)
        # секретный чат требует, чтобы у собеседника был опубликован ключ
        if secret:
            op = getattr(other, 'profile', None)
            if not op or not op.pubkey:
                return Response({'error': 'У собеседника нет ключа шифрования (пусть зайдёт в приложение)'}, status=400)
        # ищем существующий DM того же типа (обычный/секретный)
        existing = (Chat.objects.filter(type='dm', secret=secret, members=user)
                    .filter(members=other).first())
        if existing:
            return Response(chat_public(existing))
        c = Chat.objects.create(type='dm', secret=secret)
        c.members.add(user, other)
        payload = chat_public(c)
        notify_users([user.id, other.id], {'type': 'chat', 'chat': payload})
        return Response(payload)

    # group / channel
    name = (d.get('name') or '').strip()
    if not name:
        return Response({'error': 'Нужно название'}, status=400)
    member_ids = d.get('memberIds') or []
    c = Chat.objects.create(
        type=ctype, name=name[:80], owner=user,
        avatar=d.get('avatar', '') or '', description=(d.get('description') or '')[:200],
    )
    c.members.add(user)
    for mid in member_ids:
        try:
            c.members.add(User.objects.get(id=mid))
        except (User.DoesNotExist, ValueError, TypeError):
            pass
    payload = chat_public(c)
    notify_users(chat_member_ids(c), {'type': 'chat', 'chat': payload})
    return Response(payload)


@api_view(['PATCH', 'POST'])
def chat_detail(request, chat_id):
    user = request.user
    try:
        c = Chat.objects.get(id=chat_id, members=user)
    except Chat.DoesNotExist:
        return Response({'error': 'Чат не найден'}, status=404)
    d = request.data
    action = d.get('action')
    if action == 'leave':
        c.members.remove(user)
        return Response({'ok': True})
    if action == 'subscribe':  # каналы
        if user in c.members.all():
            c.members.remove(user)
        else:
            c.members.add(user)
        return Response(chat_public(c))
    if action == 'pin':
        c.pinned_message = (d.get('messageId') or '')[:24]
        c.save()
        payload = chat_public(c)
        notify_users(chat_member_ids(c), {'type': 'chat', 'chat': payload})
        return Response(payload)
    if action == 'addMembers':
        before = chat_member_ids(c)
        for mid in d.get('memberIds', []):
            try:
                c.members.add(User.objects.get(id=mid))
            except (User.DoesNotExist, ValueError, TypeError):
                pass
        payload = chat_public(c)
        notify_users(set(before) | set(chat_member_ids(c)), {'type': 'chat', 'chat': payload})
        return Response(payload)
    if action == 'removeMember':
        before = chat_member_ids(c)
        try:
            c.members.remove(User.objects.get(id=d.get('memberId')))
        except (User.DoesNotExist, ValueError, TypeError):
            pass
        payload = chat_public(c)
        notify_users(before, {'type': 'chat', 'chat': payload})
        return Response(payload)
    # обычное обновление name/avatar
    if 'name' in d:
        c.name = (d['name'] or '')[:80]
    if 'avatar' in d:
        c.avatar = d['avatar'] or ''
    c.save()
    payload = chat_public(c)
    notify_users(chat_member_ids(c), {'type': 'chat', 'chat': payload})
    return Response(payload)


# ============ СООБЩЕНИЯ ============
@api_view(['GET', 'POST'])
def messages(request, chat_id):
    user = request.user
    touch_presence(user)
    # для каналов разрешаем читать всем подписчикам; писать — владельцу
    try:
        c = Chat.objects.get(id=chat_id)
    except Chat.DoesNotExist:
        return Response({'error': 'Чат не найден'}, status=404)
    if user not in c.members.all():
        return Response({'error': 'Нет доступа'}, status=403)

    if request.method == 'GET':
        qs = c.messages.select_related('sender')
        return Response([message_public(m) for m in qs])

    d = request.data
    if c.type == 'channel' and c.owner_id != user.id:
        return Response({'error': 'Постить может только владелец канала'}, status=403)
    extra = d.get('extra') or {}
    content = d.get('content', '') or ''
    m = Message.objects.create(
        chat=c, sender=user,
        type=d.get('type', 'text'),
        content=content,
        extra=extra,
    )
    payload = message_public(m)
    notify_users(chat_member_ids(c), {'type': 'message', 'message': payload})
    # Модерация: сканируем открытый текст (E2E сервер не видит). Без блокировки —
    # сообщение доставляется, но админу уходит жалоба.
    if not extra.get('enc'):
        hit = find_banned(content + ' ' + str(extra.get('caption', '')))
        if hit:
            create_report(user, hit[0], hit[1], content, context='message', chat_id=c.id)
    return Response(payload)


@api_view(['PATCH', 'DELETE'])
def message_detail(request, message_id):
    user = request.user
    try:
        m = Message.objects.get(id=message_id)
    except Message.DoesNotExist:
        return Response({'error': 'Сообщение не найдено'}, status=404)
    if user not in m.chat.members.all():
        return Response({'error': 'Нет доступа'}, status=403)

    if request.method == 'DELETE':
        if m.sender_id != user.id:
            return Response({'error': 'Можно удалять только свои'}, status=403)
        chat_ids = chat_member_ids(m.chat)
        mid, cid = m.id, m.chat_id
        m.delete()
        notify_users(chat_ids, {'type': 'message_deleted', 'id': mid, 'chatId': cid})
        return Response({'ok': True})

    # PATCH: правка текста (только автор) либо обновление extra (реакции/прочтение/голос)
    d = request.data
    if 'content' in d:
        if m.sender_id != user.id:
            return Response({'error': 'Редактировать может только автор'}, status=403)
        m.content = d['content'] or ''
        m.edited_at = timezone.now()
    if 'extra' in d and isinstance(d['extra'], dict):
        # сливаем, чтобы реакции/прочтение от разных людей не затирали друг друга
        merged = m.extra or {}
        merged.update(d['extra'])
        m.extra = merged
    m.save()
    payload = message_public(m)
    notify_users(chat_member_ids(m.chat), {'type': 'message', 'message': payload})
    return Response(payload)


# ============ ЗАГРУЗКА ФАЙЛОВ ============
@api_view(['POST'])
def upload(request):
    f = request.FILES.get('file')
    if not f:
        return Response({'error': 'Файл не передан'}, status=400)
    if f.size > 25 * 1024 * 1024:
        return Response({'error': 'Файл больше 25 МБ'}, status=400)
    ext = os.path.splitext(f.name)[1].lower()[:12]
    # запрещаем потенциально опасные типы (SVG/HTML/скрипты → XSS и malware)
    if ext in BLOCKED_UPLOAD_EXT:
        return Response({'error': 'Такой тип файла загружать нельзя'}, status=400)
    ctype = (f.content_type or '').lower()
    if 'svg' in ctype or ctype in ('text/html', 'application/xhtml+xml', 'text/javascript', 'application/javascript'):
        return Response({'error': 'Такой тип файла загружать нельзя'}, status=400)
    safe_name = f'uploads/{uuid.uuid4().hex}{ext}'
    saved = default_storage.save(safe_name, f)
    url = request.build_absolute_uri(settings.MEDIA_URL + saved)
    return Response({'url': url, 'name': f.name, 'size': f.size, 'mime': ctype or 'application/octet-stream'})


# ============ ИСТОРИИ (STORIES) ============
STORY_TTL_HOURS = 24


def fresh_stories_qs():
    cutoff = timezone.now() - timezone.timedelta(hours=STORY_TTL_HOURS)
    return Story.objects.filter(created_at__gte=cutoff).select_related('author')


@api_view(['GET', 'POST'])
def stories(request):
    user = request.user
    touch_presence(user)
    if request.method == 'GET':
        return Response([story_public(s) for s in fresh_stories_qs()])
    d = request.data
    s = Story.objects.create(
        author=user, type=d.get('type', 'image'), content=d.get('content', '') or '',
        viewed_by=[],
    )
    # уведомим всех пользователей о новой истории
    notify_users(list(User.objects.values_list('id', flat=True)),
                 {'type': 'story', 'story': story_public(s)})
    return Response(story_public(s))


@api_view(['DELETE', 'POST'])
def story_detail(request, story_id):
    user = request.user
    try:
        s = Story.objects.get(id=story_id)
    except Story.DoesNotExist:
        return Response({'error': 'История не найдена'}, status=404)
    if request.method == 'DELETE':
        if s.author_id != user.id:
            return Response({'error': 'Можно удалять только свои'}, status=403)
        s.delete()
        return Response({'ok': True})
    # POST = отметить просмотр
    uid = str(user.id)
    vb = [str(x) for x in (s.viewed_by or [])]
    if uid not in vb:
        vb.append(uid)
        s.viewed_by = vb
        s.save()
    return Response(story_public(s))


# ============ МОДЕРАЦИЯ (жалобы для админа) ============
@api_view(['GET'])
def reports(request):
    if not request.user.is_staff:
        return Response({'error': 'Только для администратора'}, status=403)
    show_all = request.query_params.get('all') == '1'
    qs = Report.objects.all() if show_all else Report.objects.filter(resolved=False)
    return Response([report_public(r) for r in qs[:200]])


@api_view(['POST', 'DELETE'])
def report_detail(request, report_id):
    if not request.user.is_staff:
        return Response({'error': 'Только для администратора'}, status=403)
    try:
        r = Report.objects.get(id=report_id)
    except Report.DoesNotExist:
        return Response({'error': 'Не найдено'}, status=404)
    if request.method == 'DELETE':
        r.delete()
        return Response({'ok': True})
    # POST: пометить решённой
    r.resolved = True
    r.save()
    return Response(report_public(r))


# ============ БАН / РАЗБАН (только админ) ============
@api_view(['POST'])
def moderation_ban(request):
    if not request.user.is_staff:
        return Response({'error': 'Только для администратора'}, status=403)
    uid = request.data.get('userId')
    ban = request.data.get('ban', True)
    try:
        target = User.objects.get(id=uid)
    except (User.DoesNotExist, ValueError, TypeError):
        return Response({'error': 'Пользователь не найден'}, status=404)
    if target.is_staff:
        return Response({'error': 'Нельзя забанить администратора'}, status=400)
    # ban=True -> is_active=False (вход и токены блокируются)
    target.is_active = (not ban)
    target.save(update_fields=['is_active'])
    if ban:
        Token.objects.filter(user=target).delete()  # вышибаем активные сессии
    return Response({'ok': True, 'userId': str(target.id), 'banned': ban})


# ============ СИНХРОНИЗАЦИЯ (POLLING) ============
@api_view(['GET'])
def sync(request):
    """Возвращает изменения с момента ?since=<ms>: сообщения, чаты, пользователи."""
    user = request.user
    touch_presence(user)
    since_ms = request.query_params.get('since', '0')
    since = ms_to_dt(since_ms)

    my_chats = Chat.objects.filter(members=user)
    chat_ids = list(my_chats.values_list('id', flat=True))

    new_msgs = (Message.objects
                .filter(chat_id__in=chat_ids, updated_at__gt=since)
                .select_related('sender'))
    changed_chats = my_chats.filter(updated_at__gt=since).prefetch_related('members')

    # только связанные пользователи (для онлайн-статусов и карточек), не вся платформа
    people = related_users(user)

    return Response({
        'now': int(timezone.now().timestamp() * 1000),
        'messages': [message_public(m) for m in new_msgs],
        'chats': [chat_public(c) for c in changed_chats],
        'users': [user_public(u) for u in people],
        'stories': [story_public(s) for s in fresh_stories_qs()],
    })
