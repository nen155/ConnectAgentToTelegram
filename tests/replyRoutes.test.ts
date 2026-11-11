import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplyRouteStore } from '../src/telegram/replyRoutes';

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-routes-'));
  return path.join(dir, 'reply-routes.json');
}

describe('ReplyRouteStore', () => {
  it('recuerda el proyecto de un mensaje y lo resuelve', () => {
    const store = new ReplyRouteStore(tempFile());
    store.remember(42, { project: 'Silver Utilizar Silver CD 2 ISO' });

    expect(store.resolve(42)?.project).toBe('Silver Utilizar Silver CD 2 ISO');
  });

  it('devuelve undefined si el mensaje no se conoce', () => {
    const store = new ReplyRouteStore(tempFile());
    expect(store.resolve(999)).toBeUndefined();
    expect(store.resolve(undefined)).toBeUndefined();
  });

  it('persiste entre reinicios', async () => {
    const file = tempFile();
    const first = new ReplyRouteStore(file);
    first.remember(7, { project: 'MilioLab', sessionId: 'brisk-otter' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = new ReplyRouteStore(file);
    await second.load();

    expect(second.resolve(7)).toMatchObject({ project: 'MilioLab', sessionId: 'brisk-otter' });
  });

  it('no crece sin limite', () => {
    const store = new ReplyRouteStore(tempFile());
    for (let index = 0; index < 400; index += 1) {
      store.remember(index, { project: `p${index}` });
    }

    expect(store.size).toBeLessThanOrEqual(300);
    expect(store.resolve(399)?.project).toBe('p399');
    expect(store.resolve(0)).toBeUndefined();
  });
});
