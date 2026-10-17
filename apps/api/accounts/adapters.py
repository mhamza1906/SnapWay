"""allauth adapters: Google identity only; never grant map or staff privileges."""

from allauth.account.adapter import DefaultAccountAdapter
from allauth.socialaccount.adapter import DefaultSocialAccountAdapter


class AccountAdapter(DefaultAccountAdapter):
    """Block open redirects after login/logout."""

    def is_safe_url(self, url):
        if not url:
            return False
        return super().is_safe_url(url)


class SocialAccountAdapter(DefaultSocialAccountAdapter):
    """New Google users are ordinary accounts with no map-management powers."""

    def populate_user(self, request, sociallogin, data):
        user = super().populate_user(request, sociallogin, data)
        user.is_staff = False
        user.is_superuser = False
        return user

    def save_user(self, request, sociallogin, form=None):
        user = super().save_user(request, sociallogin, form=form)
        if user.is_staff or user.is_superuser:
            user.is_staff = False
            user.is_superuser = False
            user.save(update_fields=["is_staff", "is_superuser"])
        return user
