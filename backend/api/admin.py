from django.contrib import admin
from .models import Profile, Chat, Message, Story, Report

admin.site.register(Profile)
admin.site.register(Chat)
admin.site.register(Message)
admin.site.register(Story)


@admin.register(Report)
class ReportAdmin(admin.ModelAdmin):
    list_display = ('offender_username', 'category', 'term', 'context', 'resolved', 'created_at')
    list_filter = ('category', 'resolved', 'context')
    search_fields = ('offender_username', 'term', 'content')
