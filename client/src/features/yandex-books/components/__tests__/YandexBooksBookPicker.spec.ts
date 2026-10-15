import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

type ApiModule = typeof import('@/lib/api')

vi.mock('@/lib/api', () => ({ api: vi.fn<ApiModule['api']>() }))

import { api } from '@/lib/api'
import YandexBooksBookPicker from '../YandexBooksBookPicker.vue'

function response(body: unknown): Response {
  return { ok: true, json: vi.fn<() => Promise<unknown>>().mockResolvedValue(body) } as unknown as Response
}

describe('YandexBooksBookPicker', () => {
  it('searches only the chosen library and selects a human-readable result', async () => {
    vi.mocked(api).mockResolvedValueOnce(
      response({ items: [{ id: 31, title: 'The Atlas Six', authors: ['Olivie Blake'] }], total: 1, page: 0, size: 10 }),
    )
    const wrapper = mount(YandexBooksBookPicker, { props: { libraryId: 7, modelValue: null } })
    const input = wrapper.get('input')

    await input.setValue('atlas')
    await new Promise((resolve) => setTimeout(resolve, 250))
    await flushPromises()
    await wrapper.get('button[type="button"]').trigger('mousedown')

    expect(api).toHaveBeenCalledWith('/api/v1/libraries/7/books', expect.objectContaining({ method: 'POST', body: expect.stringContaining('atlas') }))
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([{ id: 31, title: 'The Atlas Six', authors: ['Olivie Blake'] }])
  })

  it('excludes the currently linked imported card from replacement choices', async () => {
    vi.mocked(api).mockResolvedValueOnce(
      response({
        items: [
          { id: 31, title: 'Imported duplicate', authors: ['Author'], files: [] },
          { id: 42, title: 'Original book', authors: ['Author'], files: [{ id: 1 }] },
        ],
        total: 2,
        page: 0,
        size: 10,
      }),
    )
    const wrapper = mount(YandexBooksBookPicker, { props: { libraryId: 7, modelValue: null, excludeBookId: 31 } })

    await wrapper.get('input').setValue('author')
    await new Promise((resolve) => setTimeout(resolve, 250))
    await flushPromises()

    expect(wrapper.text()).not.toContain('Imported duplicate')
    expect(wrapper.text()).toContain('Original book')
    expect(wrapper.text()).toContain('Attached files: 1')
  })
})
