"""Join the independently authored navigation and workspace migration histories."""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("maps", "0004_floor_connections"),
        ("maps", "0006_alter_contribution_updated_at_and_more"),
    ]

    operations = []
