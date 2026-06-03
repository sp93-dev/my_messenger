#!/usr/bin/env python
"""Точка входа Django для управления проектом."""
import os
import sys


def main():
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'server.settings')
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Не удалось импортировать Django. Убедитесь, что он установлен: "
            "python -m pip install django djangorestframework django-cors-headers"
        ) from exc
    execute_from_command_line(sys.argv)


if __name__ == '__main__':
    main()
