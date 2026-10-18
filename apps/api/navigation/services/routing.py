"""Weighted, directed routing and photo-relative guidance for published graphs."""

from __future__ import annotations

import heapq
import math
from collections import defaultdict

from maps.models import Edge, FloorConnection, Node, Publication, ReferencePhoto
from maps.services.media_store import signed_url


class RouteUnavailable(ValueError):
    pass


def shortest_path(nodes, edges, start, destination, preference="any"):
    """Dijkstra over explicit edges; never infer a walkable connection from proximity."""
    blocked = {"avoid_stairs": "stairs", "avoid_elevators": "lift"}.get(preference)
    allowed = {key for key, node in nodes.items() if node.kind != blocked}
    if start not in allowed or destination not in allowed:
        raise RouteUnavailable("The start or destination conflicts with your route preference.")
    graph = defaultdict(list)
    for source, target, cost in edges:
        if source in allowed and target in allowed and math.isfinite(cost) and cost >= 0:
            graph[source].append((target, cost))
    distances, previous = {start: 0.0}, {}
    queue = [(0.0, start)]
    while queue:
        cost, current = heapq.heappop(queue)
        if cost != distances[current]:
            continue
        if current == destination:
            path = [current]
            while current in previous:
                current = previous[current]
                path.append(current)
            return list(reversed(path)), cost
        for neighbor, weight in graph[current]:
            candidate = cost + weight
            if candidate < distances.get(neighbor, math.inf):
                distances[neighbor], previous[neighbor] = candidate, current
                heapq.heappush(queue, (candidate, neighbor))
    raise RouteUnavailable("No connected route is available with this preference.")


def bearing(source, target):
    """Clockwise from plan-up in the editor's top-left, y-down frame."""
    if source.revision_id != target.revision_id:
        return None  # Different floor plans have no shared planar coordinate system.
    dx, dy = float(target.x - source.x), float(target.y - source.y)
    if dx == 0 and dy == 0:
        return None
    frame = source.revision.coordinate_frame
    if frame.get("y_axis", "down") != "down":
        return None
    return math.degrees(math.atan2(dx, -dy)) % 360


def photo_heading(photo):
    context = photo.capture_context
    if not isinstance(context, dict) or context.get("heading_frame") != "plan_up_clockwise":
        return None
    if photo.heading_degrees is not None:
        return float(photo.heading_degrees) % 360
    return {"front": 0, "right": 90, "back": 180, "left": 270}.get(context.get("direction"))


def relative_angle(heading, target_bearing):
    if heading is None or target_bearing is None:
        return None
    return round((target_bearing - heading + 180) % 360 - 180, 2)


def guidance_frames(path, nodes, photos):
    frames = []
    for index, key in enumerate(path):
        node = nodes[key]
        next_node = nodes[path[index + 1]] if index + 1 < len(path) else None
        previous = nodes[path[index - 1]] if index else None
        desired = bearing(node, next_node) if next_node else None
        choices = photos.get(key, [])
        photo = min(
            choices,
            key=lambda ref: (
                photo_heading(ref) is None,
                abs(relative_angle(photo_heading(ref), desired) or 0),
                str(ref.id),
            ),
            default=None,
        )
        heading = photo_heading(photo) if photo else None
        transition = bool(next_node and node.revision_id != next_node.revision_id)
        label = node.label or (node.room.number if node.room_id else "Checkpoint")
        if transition:
            mode = "stairs" if node.kind == "stairs" else "elevator"
            instruction = f"Take the {mode} to {next_node.revision.target.floor.name}."
        elif next_node:
            instruction = f"Continue to {next_node.label or 'the next checkpoint'}."
        else:
            instruction = f"Destination: {label}. Check your surroundings before finishing."
        frames.append(
            {
                "node_id": key,
                "revision_id": str(node.revision_id),
                "label": label,
                "floor_name": node.revision.target.floor.name,
                "image_url": signed_url(photo.asset.storage_key, ttl=1800) if photo else None,
                "photo_id": str(photo.id) if photo else None,
                "instruction": instruction,
                "next_angle": relative_angle(heading, desired),
                "previous_angle": relative_angle(heading, bearing(node, previous))
                if previous
                else None,
                "transition": transition,
                "orientation_known": heading is not None,
            }
        )
    return frames


def published_route(
    *, start_node_id, start_revision_id, publication_id, destination_id, preference
):
    publications = list(
        Publication.objects.filter(
            is_current=True, invalidated_at__isnull=True, target__status="open"
        ).select_related("target__floor", "revision")
    )
    destination_publication = next(
        (pub for pub in publications if str(pub.id) == str(publication_id)), None
    )
    if destination_publication is None:
        raise RouteUnavailable("This destination publication is no longer available.")
    building_id = destination_publication.target.floor.building_id
    revisions = [
        pub.revision_id for pub in publications if pub.target.floor.building_id == building_id
    ]
    nodes = {
        str(node.id): node
        for node in Node.objects.filter(revision_id__in=revisions).select_related(
            "revision__target__floor", "room"
        )
    }
    start = nodes.get(str(start_node_id))
    destination = next(
        (
            node
            for node in nodes.values()
            if node.revision_id == destination_publication.revision_id
            and str(node.stable_id) == str(destination_id)
            and node.kind == "room"
        ),
        None,
    )
    if start is None or str(start.revision_id) != str(start_revision_id) or destination is None:
        raise RouteUnavailable("Your location or room does not belong to an active map here.")
    edges = [
        (str(edge.from_node_id), str(edge.to_node_id), float(edge.cost))
        for edge in Edge.objects.filter(revision_id__in=revisions, is_open=True, is_verified=True)
        if not edge.restrictions.get(preference, False)
    ]
    for connection in FloorConnection.objects.filter(
        from_node__revision_id__in=revisions,
        to_node__revision_id__in=revisions,
        is_open=True,
        is_verified=True,
    ).select_related("from_node__revision__target__floor", "to_node__revision__target__floor"):
        source, target = connection.from_node, connection.to_node
        a, b = source.revision.target.floor, target.revision.target.floor
        if (
            source.kind in {"stairs", "lift"}
            and source.kind == target.kind
            and a.id != b.id
            and a.building_id == b.building_id
        ):
            edges.append((str(source.id), str(target.id), float(connection.cost)))
    path, cost = shortest_path(nodes, edges, str(start.id), str(destination.id), preference)
    photos = defaultdict(list)
    for photo in ReferencePhoto.objects.filter(
        node_id__in=path, revision_id__in=revisions, status="reviewed"
    ).select_related("asset", "node"):
        if photo.revision_id == photo.node.revision_id:
            photos[str(photo.node_id)].append(photo)
    return {
        "frames": guidance_frames(path, nodes, photos),
        "total_cost": cost,
        "preference": preference,
        "publication_ids": [str(pub.id) for pub in publications if pub.revision_id in revisions],
    }
