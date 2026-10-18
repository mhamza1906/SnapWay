"""allauth adapters: Google identity only; never grant map or staff privileges."""

from allauth.account.adapter import DefaultAccountAdapter
from allauth.socialaccount.adapter import DefaultSocialAccountAdapter

from .modes import MODE_KEY, MODES


class AccountAdapter(DefaultAccountAdapter):
    """Block open redirects after login/logout."""

    def is_safe_url(self, url):
        if not url:
            return False
        return super().is_safe_url(url)

    def login(self, request, user):
        mode = getattr(request, "snapway_login_mode", "public")
        super().login(request, user)
        request.session[MODE_KEY] = mode if mode in MODES else "public"

    def get_login_redirect_url(self, request):
        return "/auth/complete"


class SocialAccountAdapter(DefaultSocialAccountAdapter):
    """New Google users are ordinary accounts with no map-management powers."""

    def generate_state_param(self, state):
        # Bind the selected mode to this OAuth state, including concurrent tabs.
        mode = self.request.POST.get("mode", "public")
        state["snapway_mode"] = mode if mode in MODES else "public"
        return super().generate_state_param(state)

    def pre_social_login(self, request, sociallogin):
        super().pre_social_login(request, sociallogin)
        mode = sociallogin.state.get("snapway_mode", "public")
        # allauth logs out an existing session before logging in the selected account.
        # Keep verified state on this request so session.flush() cannot erase the mode.
        request.snapway_login_mode = mode if mode in MODES else "public"

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
