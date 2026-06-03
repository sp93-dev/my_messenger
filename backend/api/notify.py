"""Рассылка событий пользователям через channel layer (WebSocket)."""
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from .consumers import user_group


def notify_users(user_ids, payload):
    """Отправляет payload (dict) в персональные группы указанных пользователей."""
    layer = get_channel_layer()
    if not layer:
        return
    for uid in set(user_ids):
        try:
            async_to_sync(layer.group_send)(
                user_group(uid),
                {'type': 'broadcast', 'payload': payload},
            )
        except Exception:
            pass


def chat_member_ids(chat):
    return list(chat.members.values_list('id', flat=True))
