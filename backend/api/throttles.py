"""Жёсткий лимит на чувствительные эндпоинты (вход/регистрация) — против перебора."""
from rest_framework.throttling import AnonRateThrottle


class AuthRateThrottle(AnonRateThrottle):
    scope = 'auth'
