"""WebSocket-потребитель: подписывает пользователя на персональную группу
и шлёт ему события (новые сообщения, изменения чатов, presence)."""
import json
from channels.generic.websocket import AsyncWebsocketConsumer


def user_group(user_id):
    return f'user_{user_id}'


class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        user = self.scope.get('user')
        if not user or not user.is_authenticated:
            await self.close()
            return
        self.group = user_group(user.id)
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()
        await self.send(text_data=json.dumps({'type': 'ready'}))

    async def disconnect(self, code):
        if hasattr(self, 'group'):
            await self.channel_layer.group_discard(self.group, self.channel_name)

    async def receive(self, text_data=None, bytes_data=None):
        # клиент может слать ping для поддержания соединения
        try:
            data = json.loads(text_data or '{}')
        except ValueError:
            return
        if data.get('type') == 'ping':
            await self.send(text_data=json.dumps({'type': 'pong'}))

    # обработчик событий, приходящих через channel layer (group_send type='broadcast')
    async def broadcast(self, event):
        await self.send(text_data=json.dumps(event['payload']))
