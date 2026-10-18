"""Join the main floor-connector and visitor-navigation migration branches."""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("maps", "0007_floor_connector"),
        ("maps", "0007_merge_navigation_workspace"),
    ]

    operations = []
