import { MapDocument, PrototypeState } from './prototype.models';

/** Fictional floor plan, deliberately unrelated to a real building or escape route. */
export function sampleMapDocument(): MapDocument {
  return {
    rooms: [
      {
        id: 'r101',
        name: 'Studio 101',
        kind: 'classroom',
        x: 80,
        y: 90,
        width: 250,
        height: 190,
        accessible: true,
      },
      {
        id: 'r102',
        name: 'Robotics Lab',
        kind: 'lab',
        x: 360,
        y: 90,
        width: 280,
        height: 190,
        accessible: true,
      },
      {
        id: 'r103',
        name: 'Meeting 103',
        kind: 'meeting',
        x: 670,
        y: 90,
        width: 250,
        height: 190,
        accessible: true,
      },
      {
        id: 'r104',
        name: 'Student Lounge',
        kind: 'amenity',
        x: 80,
        y: 360,
        width: 250,
        height: 190,
        accessible: true,
      },
      {
        id: 'r105',
        name: 'Design Office',
        kind: 'office',
        x: 360,
        y: 360,
        width: 280,
        height: 190,
        accessible: true,
      },
      {
        id: 'r106',
        name: 'Workshop 106',
        kind: 'lab',
        x: 670,
        y: 360,
        width: 250,
        height: 190,
        accessible: false,
      },
    ],
    nodes: [
      { id: 'entrance', label: 'Main entrance', x: 45, y: 320 },
      { id: 'hall-west', label: 'West corridor', x: 205, y: 320 },
      { id: 'hall-centre', label: 'Central corridor', x: 500, y: 320 },
      { id: 'hall-east', label: 'East corridor', x: 795, y: 320 },
      { id: 'node-r101', label: 'Studio 101', x: 205, y: 205, roomId: 'r101' },
      { id: 'node-r102', label: 'Robotics Lab', x: 500, y: 205, roomId: 'r102' },
      { id: 'node-r103', label: 'Meeting 103', x: 795, y: 205, roomId: 'r103' },
      { id: 'node-r104', label: 'Student Lounge', x: 205, y: 440, roomId: 'r104' },
      { id: 'node-r105', label: 'Design Office', x: 500, y: 440, roomId: 'r105' },
      { id: 'node-r106', label: 'Workshop 106', x: 795, y: 440, roomId: 'r106' },
    ],
    edges: [
      { id: 'edge-entry', from: 'entrance', to: 'hall-west', accessible: true, blocked: false },
      { id: 'edge-west', from: 'hall-west', to: 'hall-centre', accessible: true, blocked: false },
      { id: 'edge-east', from: 'hall-centre', to: 'hall-east', accessible: true, blocked: false },
      { id: 'edge-r101', from: 'hall-west', to: 'node-r101', accessible: true, blocked: false },
      { id: 'edge-r102', from: 'hall-centre', to: 'node-r102', accessible: true, blocked: false },
      { id: 'edge-r103', from: 'hall-east', to: 'node-r103', accessible: true, blocked: false },
      { id: 'edge-r104', from: 'hall-west', to: 'node-r104', accessible: true, blocked: false },
      { id: 'edge-r105', from: 'hall-centre', to: 'node-r105', accessible: true, blocked: false },
      { id: 'edge-r106', from: 'hall-east', to: 'node-r106', accessible: false, blocked: false },
      { id: 'edge-closed', from: 'node-r101', to: 'node-r102', accessible: false, blocked: true },
    ],
    annotations: [
      { id: 'label-corridor', x: 500, y: 348, text: 'MAIN CORRIDOR', type: 'label' },
      { id: 'pin-information', x: 100, y: 320, text: 'Information point', type: 'pin' },
    ],
    references: [],
  };
}

export function createPrototypeSeed(): PrototypeState {
  const at = '2026-10-16T15:30:00.000Z';
  const map = sampleMapDocument();
  const submitted = sampleMapDocument();
  submitted.annotations.push({
    id: 'pin-lift',
    x: 600,
    y: 320,
    text: 'Lift access confirmed',
    type: 'pin',
  });
  const state: PrototypeState = {
    schemaVersion: 1,
    profile: { name: 'Erfang Yuan', role: 'admin' },
    targets: [
      {
        id: 'innovation',
        name: 'Innovation Centre',
        building: 'North Campus',
        floor: 'Level 1',
        description:
          'A fictional teaching floor with six spaces, a step-free main corridor and a workshop with restricted access.',
        status: 'open',
        updatedAt: at,
        published: { version: 3, document: map, publishedAt: at, author: 'Erfang Yuan' },
      },
      {
        id: 'science',
        name: 'Science Commons',
        building: 'East Campus',
        floor: 'Level 2',
        description:
          'An uncharted floor ready for its first map. Start with the sample floor plan or upload a reference image.',
        status: 'open',
        updatedAt: at,
        published: null,
      },
      {
        id: 'library',
        name: 'Campus Library',
        building: 'Central Campus',
        floor: 'Ground floor',
        description:
          'An archived fictional mapping target. Its last publication remains available for inspection; new edits are blocked.',
        status: 'archived',
        updatedAt: at,
        published: {
          version: 1,
          document: sampleMapDocument(),
          publishedAt: at,
          author: 'Erfang Yuan',
        },
      },
    ],
    contributions: [
      {
        id: 'innovation-draft',
        targetId: 'innovation',
        title: 'Refine room labels and references',
        author: 'Erfang Yuan',
        baseRevision: 3,
        status: 'draft',
        document: sampleMapDocument(),
        summary: '',
        feedback: '',
        version: 1,
        updatedAt: at,
      },
      {
        id: 'innovation-review',
        targetId: 'innovation',
        title: 'Confirm lift access',
        author: 'Erfang Yuan',
        baseRevision: 3,
        status: 'submitted',
        document: submitted,
        summary: 'Added a lift-access landmark to the central corridor for reviewer inspection.',
        feedback: '',
        version: 1,
        updatedAt: at,
      },
    ],
    activity: [
      {
        id: 'seed-review',
        title: 'Contribution ready for review',
        detail: 'Lift access confirmation awaits an administrator decision.',
        at,
        targetId: 'innovation',
      },
      {
        id: 'seed-publication',
        title: 'Innovation Centre published',
        detail: 'Revision 3 is available to the visitor prototype.',
        at,
        targetId: 'innovation',
      },
      {
        id: 'seed-target',
        title: 'Science Commons opened',
        detail: 'This floor needs its first contribution.',
        at,
        targetId: 'science',
      },
    ],
  };
  for (const target of state.targets) {
    target.revisions = target.published ? [structuredClone(target.published)] : [];
  }
  return state;
}
