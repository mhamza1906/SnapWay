from django.contrib import admin

from maps.models import Building, Floor, MapTarget, Membership


@admin.register(Building)
class BuildingAdmin(admin.ModelAdmin):
    list_display = ("name", "slug", "created_by", "created_at")
    search_fields = ("name", "slug")


@admin.register(Floor)
class FloorAdmin(admin.ModelAdmin):
    list_display = ("name", "code", "building", "sort_order")
    list_filter = ("building",)


@admin.register(MapTarget)
class MapTargetAdmin(admin.ModelAdmin):
    list_display = ("title", "floor", "status", "created_by", "created_at")
    list_filter = ("status",)


@admin.register(Membership)
class MembershipAdmin(admin.ModelAdmin):
    list_display = ("user", "target", "role", "granted_by", "revoked_at", "created_at")
    list_filter = ("role", ("revoked_at", admin.EmptyFieldListFilter))
    search_fields = ("user__username", "user__email", "target__title")
    raw_id_fields = ("user", "target", "granted_by")
