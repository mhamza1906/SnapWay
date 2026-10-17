from django.contrib import admin

from .models import CaptureMapLink, CapturePhoto, CapturePoint, CaptureSession


@admin.register(CaptureMapLink)
class CaptureMapLinkAdmin(admin.ModelAdmin):
    list_display = ["target", "map_building_id", "map_floor_id"]


@admin.register(CaptureSession)
class CaptureSessionAdmin(admin.ModelAdmin):
    list_display = ["id", "target", "contributor", "corridor_id", "direction", "created_at"]


@admin.register(CapturePoint)
class CapturePointAdmin(admin.ModelAdmin):
    list_display = ["id", "session", "order", "status", "map_revision"]


@admin.register(CapturePhoto)
class CapturePhotoAdmin(admin.ModelAdmin):
    list_display = ["id", "point", "slot", "review_status", "map_revision", "created_at"]
