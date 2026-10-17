import {
  Contribution,
  MapDocument,
  MappingTarget,
  PrototypeState,
  PublishedRevision,
} from './prototype.models';

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function text(value: unknown, label: string, max = 500, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max)
    throw new Error(`${label} must contain ${empty ? 'at most' : '1 to'} ${max} characters.`);
  return value;
}

function id(value: unknown, label: string): string {
  const result = text(value, label, 120);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(result))
    throw new Error(`${label} contains unsupported characters.`);
  return result;
}

function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${label} must be between ${min} and ${max}.`);
  return value;
}

function integer(value: unknown, label: string, min = 0): number {
  const result = finite(value, label, min, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(result)) throw new Error(`${label} must be a whole number.`);
  return result;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  return value;
}

function choice<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (!options.includes(value as T)) throw new Error(`${label} has an unsupported value.`);
  return value as T;
}

function date(value: unknown, label: string): string {
  const result = text(value, label, 40);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be a valid date.`);
  return result;
}

function list<T>(value: unknown, label: string, max: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`${label} must be an array with at most ${max} items.`);
  return value.map(parse);
}

function unique(values: { id: string }[], label: string): void {
  if (new Set(values.map((item) => item.id)).size !== values.length)
    throw new Error(`${label} contains duplicate IDs.`);
}

function image(value: unknown, label: string): string {
  const result = text(value, label, 3_000_000);
  if (
    !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(result) &&
    !/^\/(assets|demo)\/[A-Za-z0-9_./-]+\.(png|jpe?g|webp|svg)$/.test(result)
  )
    throw new Error(`${label} must be a PNG, JPEG or WebP upload, or an application sample image.`);
  if (result.includes('..')) throw new Error(`${label} contains an invalid image path.`);
  return result;
}

export function validateMapDocument(value: unknown): MapDocument {
  const input = record(value, 'Map document');
  const document: MapDocument = {
    rooms: list(input['rooms'], 'Rooms', 200, (value) => {
      const item = record(value, 'Room');
      const x = finite(item['x'], 'Room x', 0, 1000),
        y = finite(item['y'], 'Room y', 0, 640);
      return {
        id: id(item['id'], 'Room ID'),
        name: text(item['name'], 'Room name', 120),
        kind: choice(
          item['kind'],
          ['classroom', 'office', 'lab', 'meeting', 'amenity'],
          'Room kind',
        ),
        x,
        y,
        width: finite(item['width'], 'Room width', 1, 1000 - x),
        height: finite(item['height'], 'Room height', 1, 640 - y),
        accessible: bool(item['accessible'], 'Room accessibility'),
      };
    }),
    nodes: list(input['nodes'], 'Waypoints', 500, (value) => {
      const item = record(value, 'Waypoint');
      return {
        id: id(item['id'], 'Waypoint ID'),
        label: text(item['label'], 'Waypoint label', 120),
        x: finite(item['x'], 'Waypoint x', 0, 1000),
        y: finite(item['y'], 'Waypoint y', 0, 640),
        ...(item['roomId'] === undefined ? {} : { roomId: id(item['roomId'], 'Waypoint room') }),
      };
    }),
    edges: list(input['edges'], 'Route edges', 1500, (value) => {
      const item = record(value, 'Route edge');
      return {
        id: id(item['id'], 'Edge ID'),
        from: id(item['from'], 'Edge start'),
        to: id(item['to'], 'Edge end'),
        accessible: bool(item['accessible'], 'Edge accessibility'),
        blocked: bool(item['blocked'], 'Edge blockage'),
      };
    }),
    annotations: list(input['annotations'], 'Annotations', 300, (value) => {
      const item = record(value, 'Annotation');
      return {
        id: id(item['id'], 'Annotation ID'),
        x: finite(item['x'], 'Annotation x', 0, 1000),
        y: finite(item['y'], 'Annotation y', 0, 640),
        text: text(item['text'], 'Annotation text', 500),
        type: choice(item['type'], ['label', 'pin'], 'Annotation type'),
      };
    }),
    references: list(input['references'], 'Scene references', 80, (value) => {
      const item = record(value, 'Scene reference');
      return {
        id: id(item['id'], 'Reference ID'),
        name: text(item['name'], 'Reference name', 120),
        image: image(item['image'], 'Reference image'),
        nodeId: id(item['nodeId'], 'Reference waypoint'),
        direction: text(item['direction'], 'Reference direction', 80),
        description: text(item['description'], 'Reference description', 3000, true),
        reviewed: bool(item['reviewed'], 'Reference review state'),
        createdAt: date(item['createdAt'], 'Reference date'),
      };
    }),
    ...(input['sourceImage'] === undefined
      ? {}
      : { sourceImage: image(input['sourceImage'], 'Source image') }),
    ...(input['standardizedImage'] === undefined
      ? {}
      : { standardizedImage: image(input['standardizedImage'], 'Standardized image') }),
  };
  unique(
    [
      ...document.rooms,
      ...document.nodes,
      ...document.edges,
      ...document.annotations,
      ...document.references,
    ],
    'Map',
  );
  const roomIds = new Set(document.rooms.map((room) => room.id));
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  for (const node of document.nodes)
    if (node.roomId && !roomIds.has(node.roomId))
      throw new Error(`Waypoint ${node.label} refers to a missing room.`);
  for (const edge of document.edges)
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to)
      throw new Error('Every route edge must connect two existing, different waypoints.');
  for (const reference of document.references)
    if (!nodeIds.has(reference.nodeId))
      throw new Error(`Reference ${reference.name} must be linked to an existing waypoint.`);
  return document;
}

/** A publication can be navigated, and never exposes an unreviewed scene reference. */
export function validatePublication(document: MapDocument): void {
  if (!document.rooms.length || !document.nodes.length)
    throw new Error('Add at least one room and a connected waypoint before publishing.');
  const roomNodes = document.nodes.filter((node) => node.roomId);
  if (document.rooms.some((room) => !roomNodes.some((node) => node.roomId === room.id)))
    throw new Error('Link every room to a waypoint before publishing.');
  const reached = new Set<string>([document.nodes[0].id]);
  const pending = [document.nodes[0].id];
  while (pending.length) {
    const current = pending.pop()!;
    for (const edge of document.edges.filter(
      (edge) => !edge.blocked && (edge.from === current || edge.to === current),
    )) {
      const next = edge.from === current ? edge.to : edge.from;
      if (!reached.has(next)) {
        reached.add(next);
        pending.push(next);
      }
    }
  }
  if (roomNodes.some((node) => !reached.has(node.id)))
    throw new Error('Connect all room waypoints with unblocked routes before publishing.');
  if (document.references.some((reference) => !reference.reviewed))
    throw new Error('Review every scene reference before publishing.');
}

function publication(value: unknown): PublishedRevision {
  const item = record(value, 'Publication');
  const result = {
    version: integer(item['version'], 'Publication version', 1),
    document: validateMapDocument(item['document']),
    publishedAt: date(item['publishedAt'], 'Publication date'),
    author: text(item['author'], 'Publication author', 120),
  };
  validatePublication(result.document);
  return result;
}

export function validatePrototypeState(value: unknown): PrototypeState {
  const input = record(value, 'Prototype data');
  if (input['schemaVersion'] !== 1)
    throw new Error('Unsupported data format. Import a SnapWay prototype schemaVersion 1 export.');
  const profile = record(input['profile'], 'Profile');
  const targets = list<MappingTarget>(input['targets'], 'Targets', 100, (value) => {
    const item = record(value, 'Target');
    const published = item['published'] === null ? null : publication(item['published']);
    const revisions =
      item['revisions'] === undefined
        ? published
          ? [structuredClone(published)]
          : []
        : list(item['revisions'], 'Publication history', 20, publication);
    if (
      revisions.some(
        (revision, index) => index > 0 && revision.version <= revisions[index - 1].version,
      )
    )
      throw new Error('Publication history must contain unique revisions in ascending order.');
    if (
      (!published && revisions.length) ||
      (published && JSON.stringify(revisions.at(-1)) !== JSON.stringify(published))
    )
      throw new Error('The latest retained revision must match the current publication.');
    return {
      id: id(item['id'], 'Target ID'),
      name: text(item['name'], 'Target name', 120),
      building: text(item['building'], 'Building', 120),
      floor: text(item['floor'], 'Floor', 80),
      description: text(item['description'], 'Target description', 3000, true),
      status: choice(item['status'], ['open', 'archived'], 'Target status'),
      updatedAt: date(item['updatedAt'], 'Target date'),
      published,
      revisions,
    };
  });
  const contributions = list<Contribution>(
    input['contributions'],
    'Contributions',
    200,
    (value) => {
      const item = record(value, 'Contribution');
      return {
        id: id(item['id'], 'Contribution ID'),
        targetId: id(item['targetId'], 'Contribution target'),
        title: text(item['title'], 'Contribution title', 200),
        author: text(item['author'], 'Contribution author', 120),
        baseRevision: integer(item['baseRevision'], 'Base revision'),
        status: choice(
          item['status'],
          ['draft', 'submitted', 'changes-requested', 'merged', 'rejected'],
          'Contribution status',
        ),
        document: validateMapDocument(item['document']),
        summary: text(item['summary'], 'Contribution summary', 3000, true),
        feedback: text(item['feedback'], 'Review feedback', 3000, true),
        version: integer(item['version'], 'Contribution version', 1),
        updatedAt: date(item['updatedAt'], 'Contribution date'),
      };
    },
  );
  const activity = list(input['activity'], 'Activity', 20, (value) => {
    const item = record(value, 'Activity');
    return {
      id: id(item['id'], 'Activity ID'),
      title: text(item['title'], 'Activity title', 200),
      detail: text(item['detail'], 'Activity detail', 1000, true),
      at: date(item['at'], 'Activity date'),
      ...(item['targetId'] === undefined
        ? {}
        : { targetId: id(item['targetId'], 'Activity target') }),
    };
  });
  unique(targets, 'Targets');
  unique(contributions, 'Contributions');
  unique(activity, 'Activity');
  const byTarget = new Map(targets.map((target) => [target.id, target]));
  for (const contribution of contributions) {
    const target = byTarget.get(contribution.targetId);
    if (!target) throw new Error('A contribution refers to a missing target.');
    if (contribution.baseRevision > (target.published?.version ?? 0))
      throw new Error('A contribution cannot be based on a future publication.');
    if (
      contribution.status === 'merged' &&
      (!target.published || contribution.baseRevision >= target.published.version)
    )
      throw new Error('Merged contributions require a newer published revision.');
  }
  for (const item of activity)
    if (item.targetId && !byTarget.has(item.targetId))
      throw new Error('An activity entry refers to a missing target.');
  return {
    schemaVersion: 1,
    profile: {
      name: text(profile['name'], 'Profile name', 120),
      role: choice(profile['role'], ['admin', 'volunteer'], 'Demo role'),
    },
    targets,
    contributions,
    activity,
  };
}
