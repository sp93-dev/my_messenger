"""Раздача файлов фронтенда (index.html, app.js, styles.css, api.js) самим Django."""
from django.conf import settings
from django.http import FileResponse, Http404

ALLOWED = {
    'app.js': 'application/javascript; charset=utf-8',
    'api.js': 'application/javascript; charset=utf-8',
    'styles.css': 'text/css; charset=utf-8',
}


def index(request):
    p = settings.FRONTEND_DIR / 'index.html'
    if not p.exists():
        raise Http404('index.html не найден')
    return FileResponse(open(p, 'rb'), content_type='text/html; charset=utf-8')


def frontend_file(request, name):
    if name not in ALLOWED:
        raise Http404()
    p = settings.FRONTEND_DIR / name
    if not p.exists():
        raise Http404()
    return FileResponse(open(p, 'rb'), content_type=ALLOWED[name])
