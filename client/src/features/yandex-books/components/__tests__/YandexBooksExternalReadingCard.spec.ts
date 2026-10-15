import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExternalBookReading } from '@bookorbit/types'
import YandexBooksExternalReadingCard from '../YandexBooksExternalReadingCard.vue'

const reading: ExternalBookReading = {
  provider: 'yandexBooks',
  externalId: 'y-4',
  mediaKind: 'ebook',
  remoteStatus: 'reading',
  percentage: 20,
  positionSeconds: null,
  durationSeconds: null,
  startedAt: null,
  finishedAt: null,
  syncedAt: '2026-10-15T00:00:00.000Z',
  sourceUrl: 'https://books.yandex.ru/books/y-4',
}

enableAutoUnmount(afterEach)

describe('YandexBooksExternalReadingCard', () => {
  it('offers attaching a file for a fileless Yandex book and emits the real attachment event', async () => {
    const wrapper = mount(YandexBooksExternalReadingCard, { props: { readings: [reading], fileless: true, canUpload: true } })

    await wrapper.get('button').trigger('click')

    expect(wrapper.text()).toContain('Attach a local file')
    expect(wrapper.emitted('attach')).toEqual([[]])
  })
})
