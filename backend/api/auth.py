"""Токен-авторизация с истечением (скользящее окно неактивности)."""
from django.utils import timezone
from datetime import timedelta
from rest_framework.authentication import TokenAuthentication
from rest_framework.exceptions import AuthenticationFailed

# Токен истекает после 30 дней БЕЗДЕЙСТВИЯ. Активное использование продлевает его.
TOKEN_TTL = timedelta(days=30)
# Чтобы не писать в БД на каждый запрос — продлеваем не чаще раза в сутки.
REFRESH_AFTER = timedelta(days=1)


def token_expired(token):
    return timezone.now() - token.created > TOKEN_TTL


def maybe_refresh(token):
    """Скользящее продление: если токеном пользуются, отодвигаем дату создания."""
    if timezone.now() - token.created > REFRESH_AFTER:
        token.created = timezone.now()
        token.save(update_fields=['created'])


class ExpiringTokenAuthentication(TokenAuthentication):
    def authenticate_credentials(self, key):
        user, token = super().authenticate_credentials(key)
        if token_expired(token):
            token.delete()
            raise AuthenticationFailed('Сессия истекла. Войдите снова.')
        maybe_refresh(token)
        return (user, token)
