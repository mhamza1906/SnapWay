from django.contrib.auth.models import AbstractUser


class User(AbstractUser):
    """Application identity; map-scoped roles are stored in maps.Membership."""
