from rest_framework import serializers


class MembershipSummarySerializer(serializers.Serializer):
    target_id = serializers.UUIDField()
    role = serializers.CharField()


class SessionIdentitySerializer(serializers.Serializer):
    authenticated = serializers.BooleanField()
    id = serializers.IntegerField(required=False)
    username = serializers.CharField(required=False)
    email = serializers.EmailField(required=False, allow_blank=True)
    picture = serializers.URLField(required=False, allow_blank=True)
    is_staff = serializers.BooleanField(required=False)
    is_superuser = serializers.BooleanField(required=False)
    memberships = MembershipSummarySerializer(many=True, required=False)
    mode = serializers.ChoiceField(choices=["developer", "public"], required=False)
    available_modes = serializers.ListField(child=serializers.CharField(), required=False)
    can_admin = serializers.BooleanField(required=False)


class ExperienceModeSerializer(serializers.Serializer):
    mode = serializers.ChoiceField(choices=["developer", "public"])

    def to_internal_value(self, data):
        if isinstance(data, dict) and set(data) - {"mode"}:
            raise serializers.ValidationError(
                {
                    "non_field_errors": [
                        "Only mode may be changed; permissions are managed separately."
                    ]
                }
            )
        return super().to_internal_value(data)
