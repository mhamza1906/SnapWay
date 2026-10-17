from django.contrib.auth.models import AbstractUser


class User(AbstractUser):
    """Application identity. Map-scoped membership and publication roles follow later."""
