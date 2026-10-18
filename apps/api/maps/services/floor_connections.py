"""Cross-floor connection commands require an administrator on both floor targets."""

from django.db import transaction

from maps.models import FloorConnection, Membership, Node
from maps.services.graph import GraphPermissionError
from maps.services.membership import user_has_role


@transaction.atomic
def connect_floors(*, actor, from_node_id, to_node_id, cost, bidirectional=False):
    source = Node.objects.select_related("revision__target__floor").get(pk=from_node_id)
    target = Node.objects.select_related("revision__target__floor").get(pk=to_node_id)
    for node in (source, target):
        if node.revision.target.status != "open" or not user_has_role(
            actor, node.revision.target, {Membership.Role.ADMIN}
        ):
            raise GraphPermissionError("Administrator membership is required on both floors.")
    connections = []
    for start, end in [(source, target)] + ([(target, source)] if bidirectional else []):
        connection = FloorConnection(
            from_node=start, to_node=end, cost=cost, created_by=actor, is_verified=True
        )
        connection.full_clean()
        connection.save()
        connections.append(connection)
    return connections
