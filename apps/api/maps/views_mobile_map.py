"""Hosted Google map for bundled native clients with a restricted website key."""

import secrets

from django.conf import settings
from django.shortcuts import render
from django.views.decorators.clickjacking import xframe_options_exempt
from django.views.decorators.http import require_GET


@require_GET
@xframe_options_exempt
def mobile_map(request):
    nonce = secrets.token_urlsafe(24)
    response = render(
        request,
        "maps/mobile_map.html",
        {
            "nonce": nonce,
            "map_config": {
                "key": settings.PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY,
                "mapId": settings.GOOGLE_MAPS_MAP_ID or "DEMO_MAP_ID",
            },
        },
    )
    # The only credential in this page is the intentionally public browser Maps key.
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response["Content-Security-Policy"] = (
        "default-src 'none'; "
        f"script-src 'nonce-{nonce}' https://maps.googleapis.com https://maps.gstatic.com; "
        "style-src 'unsafe-inline' https://fonts.googleapis.com; "
        "img-src data: blob: https://*.googleapis.com https://*.gstatic.com "
        "https://*.google.com https://*.googleusercontent.com; "
        "connect-src https://*.googleapis.com https://*.gstatic.com https://*.google.com; "
        "font-src https://fonts.gstatic.com; worker-src blob:; "
        "frame-src https://www.google.com; "
        "frame-ancestors 'self' capacitor://localhost https://localhost http://localhost; "
        "base-uri 'none'; form-action 'none'"
    )
    return response
