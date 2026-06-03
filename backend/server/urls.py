from django.contrib import admin
from django.urls import path, re_path, include
from . import frontend
from api.media_views import serve_media

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/', include('api.urls')),
    # защищённая раздача загруженных медиа (только с валидным токеном ?t=)
    re_path(r'^media/(?P<path>.+)$', serve_media),
    # фронтенд, который раздаёт сам Django
    path('', frontend.index),
    re_path(r'^(?P<name>app\.js|api\.js|styles\.css)$', frontend.frontend_file),
]
