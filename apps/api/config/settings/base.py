from config.environment import ROOT, env

BASE_DIR = ROOT / "apps" / "api"
DEBUG = False
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["localhost", "127.0.0.1"])
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "corsheaders",
    "drf_spectacular",
    "allauth",
    "allauth.account",
    "allauth.socialaccount",
    "allauth.socialaccount.providers.google",
    "accounts.apps.AccountsConfig",
    "maps.apps.MapsConfig",
    "jobs.apps.JobsConfig",
    "navigation.apps.NavigationConfig",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "allauth.account.middleware.AccountMiddleware",
]
AUTHENTICATION_BACKENDS = [
    "django.contrib.auth.backends.ModelBackend",
    "allauth.account.auth_backends.AuthenticationBackend",
]
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    }
]
AUTH_USER_MODEL = "accounts.User"
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
LANGUAGE_CODE = "en-ca"
TIME_ZONE = "America/Toronto"
USE_I18N = True
USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
APP_RELEASE = env("APP_RELEASE", default="development")

# Google establishes identity; map roles stay in maps.Membership / staff (never from Google).
LOGIN_REDIRECT_URL = env("LOGIN_REDIRECT_URL", default="/api/auth/me/")
ACCOUNT_LOGOUT_REDIRECT_URL = env("ACCOUNT_LOGOUT_REDIRECT_URL", default="/api/auth/me/")
ACCOUNT_ADAPTER = "accounts.adapters.AccountAdapter"
SOCIALACCOUNT_ADAPTER = "accounts.adapters.SocialAccountAdapter"
SOCIALACCOUNT_ONLY = True
ACCOUNT_EMAIL_VERIFICATION = "none"
ACCOUNT_UNIQUE_EMAIL = True
SOCIALACCOUNT_AUTO_SIGNUP = True
SOCIALACCOUNT_EMAIL_AUTHENTICATION = False
SOCIALACCOUNT_STORE_TOKENS = False

_google_client_id = env("GOOGLE_OAUTH_CLIENT_ID", default="")
_google_client_secret = env("GOOGLE_OAUTH_CLIENT_SECRET", default="")
_google_provider = {
    "SCOPE": ["openid", "email", "profile"],
    "AUTH_PARAMS": {"access_type": "online"},
    "OAUTH_PKCE_ENABLED": True,
}
# Settings-based APP only when both values are present so boot works without secrets.
if _google_client_id and _google_client_secret:
    _google_provider["APP"] = {
        "client_id": _google_client_id,
        "secret": _google_client_secret,
        "key": "",
    }
SOCIALACCOUNT_PROVIDERS = {"google": _google_provider}

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.SessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "anon": "60/min",
        "user": "300/min",
        "localization": env("LOCALIZATION_RATE", default="60/min"),
    },
}
SPECTACULAR_SETTINGS = {"TITLE": "SnapWay API", "VERSION": "0.1.0"}
CSRF_COOKIE_NAME = "XSRF-TOKEN"
CSRF_HEADER_NAME = "HTTP_X_XSRF_TOKEN"
CSRF_COOKIE_HTTPONLY = False
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])
CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=[])
CORS_ALLOW_CREDENTIALS = False
STATIC_URL = "/django-static/"
MEDIA_URL = "/media/"
DATA_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024

CELERY_BROKER_URL = env("CELERY_BROKER_URL", default="redis://127.0.0.1:6379/0")
CELERY_RESULT_BACKEND = None
CELERY_TASK_DEFAULT_QUEUE = "authoring"
CELERY_TASK_SERIALIZER = "json"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_TIME_LIMIT = 300
CELERY_TASK_SOFT_TIME_LIMIT = 280
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True

# Visual place matching (apps/place-match mobile engine). The API forwards frames to the
# engine on a private address; it never stores frames or holds Google credentials.
PLACEMATCH_ENGINE_URL = env("PLACEMATCH_ENGINE_URL", default="")
PLACEMATCH_ENGINE_TOKEN = env("PLACEMATCH_ENGINE_TOKEN", default="")
PLACEMATCH_ENGINE_TIMEOUT_S = env.float("PLACEMATCH_ENGINE_TIMEOUT_S", default=30.0)
# Development-only bearer token for the iOS debug build; ignored unless DEBUG is true.
PLACEMATCH_DEV_TOKEN = env("PLACEMATCH_DEV_TOKEN", default="")
