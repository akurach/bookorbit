<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ExternalLink, FilePlus } from '@lucide/vue'
import type { ExternalBookReading } from '@bookorbit/types'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  readings: ExternalBookReading[]
  fileless: boolean
  canUpload: boolean
}>()

const emit = defineEmits<{ attach: [] }>()
const { t } = useI18n()

const yandexReadings = computed(() => props.readings.filter((reading) => reading.provider === 'yandexBooks'))

function progressLabel(reading: ExternalBookReading): string | null {
  if (reading.percentage !== null) return `${Math.round(reading.percentage)}%`
  if (reading.positionSeconds !== null && reading.durationSeconds) {
    return `${Math.floor(reading.positionSeconds / 60)} / ${Math.floor(reading.durationSeconds / 60)} min`
  }
  return null
}

function syncedLabel(reading: ExternalBookReading): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(reading.syncedAt))
}

function handleAttach(): void {
  emit('attach')
}
</script>

<template>
  <section v-if="yandexReadings.length" class="rounded-lg border border-border bg-card px-4 py-4 shadow-xs">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="text-sm font-medium">{{ t('yandexBooks.externalReading.title') }}</p>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t('yandexBooks.externalReading.description') }}</p>
      </div>
      <Button v-if="fileless && canUpload" type="button" size="sm" @click="handleAttach">
        <FilePlus class="size-3.5" />
        {{ t('yandexBooks.externalReading.attachFile') }}
      </Button>
    </div>

    <p v-if="fileless" class="mt-3 text-xs text-muted-foreground">{{ t('yandexBooks.externalReading.attachFileHint') }}</p>

    <div class="mt-3 divide-y divide-border rounded-md border border-border">
      <div v-for="reading in yandexReadings" :key="reading.externalId" class="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-xs">
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
          <span>{{ t('yandexBooks.externalReading.status', { status: reading.remoteStatus }) }}</span>
          <span v-if="progressLabel(reading)">{{ t('yandexBooks.externalReading.progress', { value: progressLabel(reading) }) }}</span>
          <span>{{ t('yandexBooks.externalReading.synced', { date: syncedLabel(reading) }) }}</span>
        </div>
        <a :href="reading.sourceUrl" target="_blank" rel="noopener" class="flex items-center gap-1 text-primary hover:underline">
          {{ t('yandexBooks.externalReading.open') }}
          <ExternalLink class="size-3" />
        </a>
      </div>
    </div>
  </section>
</template>
