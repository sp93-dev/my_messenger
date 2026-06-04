from django.urls import path
from . import views

urlpatterns = [
    # авторизация
    path('register', views.register),
    path('login', views.login),
    path('logout', views.logout),
    # профиль / пользователи
    path('me', views.me),
    path('users', views.users_list),
    path('users/search', views.users_search),
    path('presence', views.presence),
    # чаты
    path('chats', views.chats),
    path('chats/<str:chat_id>', views.chat_detail),
    path('chats/<str:chat_id>/messages', views.messages),
    path('chats/<str:chat_id>/typing', views.typing),
    # сообщения
    path('messages/<str:message_id>', views.message_detail),
    # загрузка файлов
    path('upload', views.upload),
    # истории
    path('stories', views.stories),
    path('stories/<str:story_id>', views.story_detail),
    # модерация (только админ)
    path('reports', views.reports),
    path('reports/<int:report_id>', views.report_detail),
    path('moderation/ban', views.moderation_ban),
    # синхронизация
    path('sync', views.sync),
]
