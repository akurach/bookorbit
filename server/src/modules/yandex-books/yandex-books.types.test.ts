import { describe, expect, it } from 'vitest';

import { mapAudio, mapComic, mapTextCard } from './yandex-books.types';

describe('Yandex Books item mapping', () => {
  it('maps a text card without treating CFI as a local position', () => {
    const item = mapTextCard({
      state: 'pending',
      progress: 45,
      started_at: 0,
      finished_at: 0,
      cfi: '/6/2',
      book: { uuid: 'text-1', title: 'Икигай', authors: 'Франсеск Миральес', language: 'ru', cover: { large: 'https://example.test/large.jpg' } },
    });
    expect(item).toMatchObject({
      externalId: 'text-1',
      mediaKind: 'ebook',
      status: 'on_hold',
      percentage: 45,
      positionSeconds: null,
      startedAt: null,
      coverUrl: 'https://example.test/large.jpg',
    });
  });
  it('maps audio progress from seconds and duration', () => {
    const item = mapAudio({ uuid: 'audio-1', title: 'Atlas', authors: 'Author', duration: 1000, audio_card: { state: 'listening', progress: 250 } });
    expect(item).toMatchObject({ mediaKind: 'audiobook', status: 'reading', positionSeconds: 250, durationSeconds: 1000, percentage: 25 });
  });
  it('does not claim comic progress units are percentages', () => {
    const item = mapComic({ uuid: 'comic-1', title: 'Comic', comic_card: { state: 'reading', progress: 8 } });
    expect(item).toMatchObject({ mediaKind: 'comic', status: 'reading', percentage: null });
  });
  it('uses the source-specific URL and accepts actual array authors', () => {
    const item = mapAudio({
      uuid: 'audio-1',
      title: 'Atlas',
      authors: ['Author'],
      duration: 100,
      cover: { small: 'https://example.test/s.jpg' },
      audio_card: { state: 'pending', progress: 0 },
    });
    expect(item).toMatchObject({
      sourceUrl: 'https://books.yandex.ru/audiobooks/audio-1',
      authors: ['Author'],
      coverUrl: 'https://example.test/s.jpg',
    });
  });
  it('does not fabricate an invalid percentage or unknown status', () => {
    const item = mapTextCard({ state: 'unknown', progress: 101, book: { uuid: 'text-1', title: 'Test' } });
    expect(item).toMatchObject({ status: null, percentage: null });
  });
  it('rejects malformed cards', () => {
    expect(mapTextCard({ state: 'reading', book: { title: 'No id' } })).toBeNull();
  });
});
