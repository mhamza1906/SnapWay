from django.test import override_settings
from django.urls import reverse
from rest_framework.test import APIClient


@override_settings(
    PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY="public-test-map-key", GOOGLE_MAPS_MAP_ID="map-test"
)
def test_native_map_is_anonymous_and_uses_only_public_maps_configuration():
    response = APIClient().get(reverse("mobile-walking-map"))
    assert response.status_code == 200
    text = response.content.decode()
    assert "public-test-map-key" in text
    assert "map-test" in text
    assert "photos/" not in text
    assert "PLACEMATCH_ENGINE_TOKEN" not in text
    assert "X-Frame-Options" not in response
    assert (
        "frame-ancestors 'self' capacitor://localhost https://localhost"
        in response["Content-Security-Policy"]
    )
    assert "nonce-" in response["Content-Security-Policy"]
    assert response["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert response["Cache-Control"] == "no-store"


def test_native_map_rejects_posts_and_checks_sender_and_coordinates():
    client = APIClient()
    assert client.post(reverse("mobile-walking-map"), {}).status_code == 405
    text = client.get(reverse("mobile-walking-map")).content.decode()
    assert "event.source !== parent" in text
    assert "allowed.has(event.origin)" in text
    assert "event.data.channel !== channel" in text
    assert "Math.abs(value.lat) <= 90" in text
