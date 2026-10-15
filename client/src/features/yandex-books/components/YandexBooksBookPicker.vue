<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Search, X } from '@lucide/vue'
import type { BookCard, BookQuery, BooksPage } from '@bookorbit/types'
import { api } from '@/lib/api'

const props = defineProps<{ libraryId: number }>()
const model = defineModel<BookCard | null>({ required: true })
const { t } = useI18n()
const query = ref('')
const options = ref<BookCard[]>([])
const loading = ref(false)
const open = ref(false)
const error = ref(false)
const activeIndex = ref(-1)
let timer: ReturnType<typeof setTimeout> | null = null
let requestId = 0

const selectedLabel = computed(() => (model.value ? [model.value.title, model.value.authors.join(', ')].filter(Boolean).join(' · ') : ''))

async function search(): Promise<void> {
  const value = query.value.trim()
  const current = ++requestId
  if (value.length < 2) {
    options.value = []
    loading.value = false
    return
  }
  loading.value = true
  error.value = false
  try {
    const body: BookQuery = { q: value, sort: [{ field: 'title', dir: 'asc' }], pagination: { page: 0, size: 10 } }
    const res = await api(`/api/v1/libraries/${props.libraryId}/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok || current !== requestId) {
      if (current === requestId) error.value = true
      return
    }
    options.value = ((await res.json()) as BooksPage).items
    activeIndex.value = -1
  } catch {
    if (current === requestId) {
      options.value = []
      error.value = true
    }
  } finally {
    if (current === requestId) loading.value = false
  }
}

function handleInput(event: Event): void {
  query.value = (event.target as HTMLInputElement).value
  open.value = true
  requestId += 1
  error.value = false
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void search(), 200)
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = Math.min(activeIndex.value + 1, options.value.length - 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = Math.max(activeIndex.value - 1, -1)
  } else if (event.key === 'Enter' && activeIndex.value >= 0) {
    event.preventDefault()
    const book = options.value[activeIndex.value]
    if (book) choose(book)
  } else if (event.key === 'Escape') {
    open.value = false
  }
}

function handleFocus(): void {
  open.value = true
}

function handleBlur(): void {
  setTimeout(() => (open.value = false), 150)
}

function choose(book: BookCard): void {
  model.value = book
  query.value = ''
  open.value = false
}

function clear(): void {
  model.value = null
  query.value = ''
  options.value = []
}

onUnmounted(() => {
  if (timer) clearTimeout(timer)
  requestId += 1
})
</script>

<template>
  <div class="relative min-w-0 flex-1">
    <input
      :value="selectedLabel || query"
      type="text"
      :placeholder="t('yandexBooks.entries.searchExisting')"
      class="h-8 w-full rounded border border-border bg-background pl-2.5 pr-8 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
      @focus="handleFocus"
      @input="handleInput"
      @keydown="handleKeydown"
      @blur="handleBlur"
    />
    <button
      v-if="model"
      type="button"
      :aria-label="t('yandexBooks.entries.clearSelection')"
      class="absolute right-1 top-1 inline-flex size-6 items-center justify-center text-muted-foreground"
      @mousedown.prevent="clear"
    >
      <X class="size-3.5" />
    </button>
    <Search v-else class="pointer-events-none absolute right-2 top-2 size-3.5 text-muted-foreground" />
    <div
      v-if="open && query.trim().length >= 2"
      class="absolute z-50 mt-1 max-h-52 w-full overflow-y-auto rounded-md border border-border bg-popover shadow-md"
    >
      <p v-if="loading" class="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 class="size-3 animate-spin" />{{ t('yandexBooks.entries.searching') }}
      </p>
      <p v-else-if="error" class="px-3 py-2 text-xs text-destructive">{{ t('yandexBooks.entries.searchFailed') }}</p>
      <p v-else-if="options.length === 0" class="px-3 py-2 text-xs text-muted-foreground">{{ t('yandexBooks.entries.noBooksFound') }}</p>
      <button
        v-for="(book, index) in options"
        :key="book.id"
        type="button"
        class="w-full px-3 py-2 text-left text-xs hover:bg-accent"
        :class="{ 'bg-accent': index === activeIndex }"
        @mousedown.prevent="choose(book)"
      >
        <span class="block truncate font-medium">{{ book.title ?? t('yandexBooks.entries.untitled') }}</span>
        <span class="block truncate text-muted-foreground">{{ book.authors.join(', ') }}</span>
      </button>
    </div>
  </div>
</template>
