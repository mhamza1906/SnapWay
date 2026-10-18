import { PointPhotoQueue } from './point-photo-queue';

describe('pending phone reference photos', () => {
  it('replaces only the same point/view and removes only acknowledged uploads', async () => {
    const queue = new PointPhotoQueue();
    await queue.open('account-a');
    const input = {
      revisionId: 'r',
      nodeId: 'n1',
      direction: 'front' as const,
      blob: new Blob(['one']),
      filename: 'p.jpg',
    };
    const first = await queue.save(input);
    await queue.save({ ...input, blob: new Blob(['replacement']) });
    await queue.save({ ...input, nodeId: 'n2' });
    expect(queue.items()).toHaveLength(2);
    expect(
      await queue
        .items()
        .find((p) => p.nodeId === 'n1')!
        .blob.text(),
    ).toBe('replacement');
    await queue.remove(first.id);
    expect(queue.items().map((p) => p.nodeId)).toEqual(['n2']);
    await queue.open('account-b');
    expect(queue.items()).toEqual([]);
  });
});
