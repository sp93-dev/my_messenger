"""Middleware авторизации WebSocket по токену из query-строки (?token=...)."""
from urllib.parse import parse_qs
from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser


@database_sync_to_async
def get_user_from_token(key):
    from rest_framework.authtoken.models import Token
    from .auth import token_expired
    try:
        token = Token.objects.select_related('user').get(key=key)
    except Token.DoesNotExist:
        return AnonymousUser()
    if token_expired(token):
        token.delete()
        return AnonymousUser()
    return token.user


class TokenAuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        query = parse_qs((scope.get('query_string') or b'').decode())
        token = (query.get('token') or [None])[0]
        scope['user'] = await get_user_from_token(token) if token else AnonymousUser()
        return await self.app(scope, receive, send)
