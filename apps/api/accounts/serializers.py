from rest_framework import serializers


class MembershipSummarySerializer(serializers.Serializer):
    target_id = serializers.UUIDField()
    role = serializers.CharField()


class SessionIdentitySerializer(serializers.Serializer):
    authenticated = serializers.BooleanField()
    id = serializers.IntegerField(required=False)
    username = serializers.CharField(required=False)
    email = serializers.EmailField(required=False, allow_blank=True)
    is_staff = serializers.BooleanField(required=False)
    is_superuser = serializers.BooleanField(required=False)
    memberships = MembershipSummarySerializer(many=True, required=False)
