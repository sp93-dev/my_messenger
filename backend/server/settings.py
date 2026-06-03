"""Настройки Django-проекта мессенджера (dev + prod через переменные окружения)."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def env_bool(name, default):
    return os.environ.get(name, str(default)).lower() in ('1', 'true', 'yes', 'on')


# --- Безопасность / окружение ---
SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-key-change-me-in-production-0xА1B2C3')
DEBUG = env_bool('DEBUG', True)
ALLOWED_HOSTS = [h.strip() for h in os.environ.get('ALLOWED_HOSTS', '*').split(',') if h.strip()]
# Render автоматически передаёт внешний хост в этой переменной
_render_host = os.environ.get('RENDER_EXTERNAL_HOSTNAME')
if _render_host and _render_host not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append(_render_host)

# CSRF для админки/форм по HTTPS
CSRF_TRUSTED_ORIGINS = [o.strip() for o in os.environ.get('CSRF_TRUSTED_ORIGINS', '').split(',') if o.strip()]
if _render_host:
    CSRF_TRUSTED_ORIGINS.append('https://' + _render_host)

# Папка с фронтендом (index.html, app.js, styles.css, api.js) — на уровень выше backend/
FRONTEND_DIR = BASE_DIR.parent

INSTALLED_APPS = [
    'daphne',  # ASGI-сервер для WebSocket (должен быть выше staticfiles)
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'rest_framework',
    'rest_framework.authtoken',
    'corsheaders',
    'channels',
    'api',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]
# whitenoise может быть не установлен в dev — убираем мягко
try:
    import whitenoise  # noqa: F401
except ImportError:
    MIDDLEWARE = [m for m in MIDDLEWARE if 'whitenoise' not in m]

ROOT_URLCONF = 'server.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'server.wsgi.application'
ASGI_APPLICATION = 'server.asgi.application'

# --- База данных ---
# По умолчанию SQLite. Для PostgreSQL задайте DATABASE_URL=postgres://user:pass@host:port/db
DATABASE_URL = os.environ.get('DATABASE_URL', '')
if DATABASE_URL.startswith('postgres'):
    from urllib.parse import urlparse, parse_qs
    u = urlparse(DATABASE_URL)
    # пробрасываем sslmode из строки подключения (нужно для ВНЕШНЕГО подключения к Render)
    options = {}
    qs = parse_qs(u.query)
    if 'sslmode' in qs:
        options['sslmode'] = qs['sslmode'][0]
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.postgresql',
            'NAME': u.path.lstrip('/'),
            'USER': u.username,
            'PASSWORD': u.password,
            'HOST': u.hostname,
            'PORT': u.port or 5432,
            **({'OPTIONS': options} if options else {}),
        }
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': BASE_DIR / 'db.sqlite3',
        }
    }

# --- Channels (WebSocket) ---
REDIS_URL = os.environ.get('REDIS_URL', '')
if REDIS_URL:
    CHANNEL_LAYERS = {
        'default': {
            'BACKEND': 'channels_redis.core.RedisChannelLayer',
            'CONFIG': {'hosts': [REDIS_URL]},
        }
    }
else:
    # Для разработки (один процесс) хватает in-memory слоя
    CHANNEL_LAYERS = {'default': {'BACKEND': 'channels.layers.InMemoryChannelLayer'}}

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
     'OPTIONS': {'min_length': 8}},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

LANGUAGE_CODE = 'ru-ru'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = 'static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STATICFILES_STORAGE = 'django.contrib.staticfiles.storage.StaticFilesStorage'

# --- Загруженные медиа ---
MEDIA_URL = '/media/'
MEDIA_ROOT = BASE_DIR / 'media'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'api.auth.ExpiringTokenAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
    # Защита от перебора и спама
    'DEFAULT_THROTTLE_CLASSES': [
        'rest_framework.throttling.AnonRateThrottle',
        'rest_framework.throttling.UserRateThrottle',
    ],
    'DEFAULT_THROTTLE_RATES': {
        'anon': '60/min',      # незалогиненные (вход/регистрация и пр.)
        'user': '3000/min',    # залогиненные (с запасом на опрос/синхронизацию)
        'auth': '15/min',      # отдельный жёсткий лимит на вход/регистрацию
    },
}

# CORS: в разработке разрешаем всё, в проде — только свои домены (в проде
# фронтенд раздаётся тем же Django, поэтому CORS по сути и не нужен).
CORS_ALLOW_ALL_ORIGINS = DEBUG
CORS_ALLOWED_ORIGINS = [o.strip() for o in os.environ.get('CORS_ALLOWED_ORIGINS', '').split(',') if o.strip()]
CORS_ALLOW_CREDENTIALS = True

# Базовая защита заголовками
SECURE_CONTENT_TYPE_NOSNIFF = True

# Прод-ужесточения (только когда DEBUG=false)
if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')  # Render терминирует HTTPS
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_HSTS_SECONDS = 2592000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True

# Лимит тела запроса: до 30 МБ (на случай оставшихся data-url)
DATA_UPLOAD_MAX_MEMORY_SIZE = 30 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 30 * 1024 * 1024
