@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Запуск бэкенда мессенджера (Django)
echo   API: http://127.0.0.1:8000/api
echo   Не закрывайте это окно во время работы.
echo ============================================
python manage.py migrate
python manage.py runserver 127.0.0.1:8000
pause
