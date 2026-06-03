"""Модели мессенджера: профиль пользователя, чаты, сообщения."""
import uuid
from django.db import models
from django.contrib.auth.models import User


def gen_id():
    return uuid.uuid4().hex[:16]


class Profile(models.Model):
    """Расширение стандартного пользователя Django доп. полями."""
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    name = models.CharField(max_length=64)                 # отображаемое имя
    avatar = models.TextField(blank=True, default='')       # data-url или пусто
    bio = models.CharField(max_length=200, blank=True, default='')
    status = models.CharField(max_length=100, blank=True, default='')
    mood = models.CharField(max_length=8, blank=True, default='')
    vip_tag = models.CharField(max_length=12, blank=True, default='')
    is_vip = models.BooleanField(default=False)
    pubkey = models.TextField(blank=True, default='')   # публичный ключ E2E (base64 SPKI)
    phone = models.CharField(max_length=32, blank=True, default='', db_index=True)  # только цифры
    last_seen = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f'@{self.user.username} ({self.name})'


class Chat(models.Model):
    TYPE_CHOICES = [
        ('dm', 'Личный'),
        ('group', 'Группа'),
        ('channel', 'Канал'),
        ('saved', 'Избранное'),
    ]
    id = models.CharField(primary_key=True, max_length=24, default=gen_id, editable=False)
    type = models.CharField(max_length=10, choices=TYPE_CHOICES, default='dm')
    name = models.CharField(max_length=80, blank=True, default='')
    avatar = models.TextField(blank=True, default='')
    description = models.CharField(max_length=200, blank=True, default='')
    owner = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='owned_chats')
    members = models.ManyToManyField(User, related_name='chats')
    secret = models.BooleanField(default=False)   # E2E-шифрованный секретный чат
    pinned_message = models.CharField(max_length=24, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'{self.type}:{self.id} {self.name}'


class Message(models.Model):
    id = models.CharField(primary_key=True, max_length=24, default=gen_id, editable=False)
    chat = models.ForeignKey(Chat, on_delete=models.CASCADE, related_name='messages')
    sender = models.ForeignKey(User, on_delete=models.CASCADE, related_name='messages')
    type = models.CharField(max_length=16, default='text')   # text/image/video/sticker/voice/...
    content = models.TextField(blank=True, default='')        # текст или data-url
    # Гибкое поле под caption, album, poll, reactions, readBy, replyTo, selfDestruct и т.д.
    extra = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    edited_at = models.DateTimeField(null=True, blank=True)
    # для polling: монотонная отметка изменения
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['created_at']

    def __str__(self):
        return f'{self.id} {self.type} from @{self.sender.username}'


class Report(models.Model):
    """Жалоба для модерации: пользователь написал сообщение с запрещённым контентом.
    Пользователь НЕ блокируется — админ получает уведомление и решает сам."""
    offender = models.ForeignKey(User, on_delete=models.CASCADE, related_name='reports', null=True, blank=True)
    offender_username = models.CharField(max_length=150)
    category = models.CharField(max_length=32)          # терроризм/наркотики/...
    term = models.CharField(max_length=120)             # что совпало
    content = models.TextField(blank=True, default='')  # сам текст
    context = models.CharField(max_length=24, default='message')  # message/profile
    chat_id = models.CharField(max_length=24, blank=True, default='')
    resolved = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'REPORT @{self.offender_username} ({self.category}: {self.term})'


class Story(models.Model):
    id = models.CharField(primary_key=True, max_length=24, default=gen_id, editable=False)
    author = models.ForeignKey(User, on_delete=models.CASCADE, related_name='stories')
    type = models.CharField(max_length=10, default='image')  # image/video
    content = models.TextField()                             # URL или data-url
    viewed_by = models.JSONField(default=list, blank=True)   # список id посмотревших
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at']

    def __str__(self):
        return f'story {self.id} by @{self.author.username}'
