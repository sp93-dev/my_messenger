"""Раздача загруженных медиа только авторизованным пользователям.

Токен передаётся в query (?t=...), т.к. тег <img>/<video> не умеет слать заголовки.
Документы (не фото/видео/аудио) отдаются как вложение, чтобы не исполнялись в браузере.
"""
import os
import mimetypes
from django.conf import settings
from django.http import FileResponse, HttpResponseForbidden, Http404


def _valid_token(request):
    from rest_framework.authtoken.models import Token
    from .auth import token_expired
    key = request.GET.get('t') or ''
    if not key:
        # поддержим заголовок Authorization на всякий случай
        auth = request.META.get('HTTP_AUTHORIZATION', '')
        if auth.startswith('Token '):
            key = auth[6:]
    if not key:
        return False
    try:
        token = Token.objects.get(key=key)
    except Token.DoesNotExist:
        return False
    if token_expired(token):
        return False
    return True


def serve_media(request, path):
    if not _valid_token(request):
        return HttpResponseForbidden('Доступ только для авторизованных пользователей')
    # защита от выхода за пределы каталога
    full = os.path.normpath(os.path.join(settings.MEDIA_ROOT, path))
    if not full.startswith(os.path.normpath(str(settings.MEDIA_ROOT))):
        raise Http404()
    if not os.path.exists(full) or not os.path.isfile(full):
        raise Http404()
    ctype, _ = mimetypes.guess_type(full)
    ctype = ctype or 'application/octet-stream'
    resp = FileResponse(open(full, 'rb'), content_type=ctype)
    resp['X-Content-Type-Options'] = 'nosniff'
    # фото/видео/аудио показываем inline, остальное — скачиванием (без исполнения)
    inline = ctype.startswith(('image/', 'video/', 'audio/')) and 'svg' not in ctype
    disp = 'inline' if inline else 'attachment'
    resp['Content-Disposition'] = f'{disp}; filename="{os.path.basename(full)}"'
    return resp
