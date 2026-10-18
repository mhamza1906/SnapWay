import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("maps", "0006_alter_contribution_updated_at_and_more"),
    ]

    operations = [
        migrations.CreateModel(
            name="FloorConnector",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("code", models.CharField(max_length=40)),
                (
                    "kind",
                    models.CharField(
                        choices=[("stairs", "Stairs"), ("lift", "Lift")], max_length=16
                    ),
                ),
                ("label", models.CharField(blank=True, max_length=200)),
                ("endpoints", models.JSONField(blank=True, default=list)),
                (
                    "building",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="floor_connectors",
                        to="maps.building",
                    ),
                ),
            ],
        ),
        migrations.AddConstraint(
            model_name="floorconnector",
            constraint=models.UniqueConstraint(
                fields=("building", "code"), name="floor_connector_code_uq"
            ),
        ),
        migrations.AddConstraint(
            model_name="floorconnector",
            constraint=models.CheckConstraint(
                condition=models.Q(("kind__in", ["stairs", "lift"])),
                name="floor_connector_kind_ck",
            ),
        ),
    ]
