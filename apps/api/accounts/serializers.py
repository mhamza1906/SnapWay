from rest_framework import serializers


class SessionIdentitySerializer(serializers.Serializer):
    authenticated = serializers.BooleanField()
    id = serializers.IntegerField(required=False)
    username = serializers.CharField(required=False)
    email = serializers.EmailField(required=False, allow_blank=True)
    is_staff = serializers.BooleanField(required=False)
    is_superuser = serializers.BooleanField(required=False)
