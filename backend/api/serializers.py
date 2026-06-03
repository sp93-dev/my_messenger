"""Сериализаторы для преобразования моделей в JSON."""
from django.utils import timezone
from rest_framework import serializers
from .models import Profile, Chat, Message

ONLINE_THRESHOLD = 30  # секунд


def user_public(user, include_phone=False):
    """Публичная карточка пользователя для фронтенда.
    Телефон отдаём только самому себе (include_phone=True)."""
    p = getattr(user, 'profile', None)
    online = False
    last_seen = None
    if p and p.last_seen:
        delta = (timezone.now() - p.last_seen).total_seconds()
        online = delta < ONLINE_THRESHOLD
        last_seen = p.last_seen.isoformat()
    return {
        'id': str(user.id),
        'username': user.username,
        'name': p.name if p else user.username,
        'avatar': p.avatar if p else '',
        'bio': p.bio if p else '',
        'status': p.status if p else '',
        'mood': p.mood if p else '',
        'vipTag': p.vip_tag if p else '',
        'isVip': p.is_vip if p else False,
        'pubkey': p.pubkey if p else '',
        'isAdmin': bool(user.is_staff),
        'phone': (p.phone if (p and include_phone) else ''),
        'online': online,
        'lastSeen': last_seen,
    }


def report_public(r):
    return {
        'id': r.id,
        'offenderId': str(r.offender_id) if r.offender_id else None,
        'offender': r.offender_username,
        'category': r.category,
        'term': r.term,
        'content': r.content,
        'context': r.context,
        'chatId': r.chat_id,
        'resolved': r.resolved,
        'timestamp': int(r.created_at.timestamp() * 1000),
    }


def message_public(m):
    return {
        'id': m.id,
        'chatId': m.chat_id,
        'senderId': str(m.sender_id),
        'type': m.type,
        'content': m.content,
        'extra': m.extra or {},
        'timestamp': int(m.created_at.timestamp() * 1000),
        'editedAt': int(m.edited_at.timestamp() * 1000) if m.edited_at else None,
        'updatedAt': int(m.updated_at.timestamp() * 1000),
    }


def chat_public(chat):
    return {
        'id': chat.id,
        'type': chat.type,
        'name': chat.name,
        'avatar': chat.avatar,
        'description': chat.description,
        'ownerId': str(chat.owner_id) if chat.owner_id else None,
        'secret': chat.secret,
        'pinnedId': chat.pinned_message or None,
        'members': [str(uid) for uid in chat.members.values_list('id', flat=True)],
        'createdAt': int(chat.created_at.timestamp() * 1000),
        'updatedAt': int(chat.updated_at.timestamp() * 1000),
    }


def story_public(s):
    return {
        'id': s.id,
        'userId': str(s.author_id),
        'type': s.type,
        'content': s.content,
        'viewedBy': [str(x) for x in (s.viewed_by or [])],
        'timestamp': int(s.created_at.timestamp() * 1000),
    }
