<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, CheckCircle2, Clock3, Download, ExternalLink, Loader2, RefreshCw, Save, Unplug } from '@lucide/vue'
import { toast } from 'vue-sonner'
import type { BookCard, Library, YandexBooksEntry } from '@bookorbit/types'
import { Permission } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import SettingsPageHeader from '@/features/settings/SettingsPageHeader.vue'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { SECRET_INPUT_ATTRS } from '@/lib/secret-input'
import { useYandexBooks } from '../composables/useYandexBooks'
import YandexBooksBookPicker from './YandexBooksBookPicker.vue'

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })
const { t } = useI18n()
const { hasPermission } = usePermissions()
const { libraries, fetchLibraries } = useLibraries()
const {
  settings,
  entries,
  loading,
  saving,
  syncing,
  importing,
  error,
  connected,
  loadSettings,
  saveSettings,
  disconnect,
  loadEntries,
  startSync,
  importEntries,
  resolveEntry,
  linkEntry,
  stopPolling,
} = useYandexBooks()

const token = ref('')
const tokenVisible = ref(false)
const selectedState = ref<string>('')
const linkEntryId = ref<number | null>(null)
const linkedBook = ref<BookCard | null>(null)
const linking = ref(false)
const form = reactive({
  libraryId: 0,
  libraryFolderId: 0,
  autoSync: true,
  intervalHours: 24,
})

const canConfigure = computed(() => hasPermission(Permission.YandexBooksSync))
const canImport = computed(() => canConfigure.value && hasPermission(Permission.LibraryUpload))
const bookLibraries = computed(() => libraries.value.filter((library) => library.type === 'books'))
const selectedLibrary = computed<Library | null>(() => bookLibraries.value.find((library) => library.id === form.libraryId) ?? null)
const selectedFolders = computed(() => selectedLibrary.value?.folders ?? [])
const isConfigured = computed(() => settings.value?.tokenConfigured && form.libraryId > 0 && form.libraryFolderId > 0)
const importableCount = computed(() => entries.value?.total ?? 0)
const totalPages = computed(() => Math.max(1, Math.ceil((entries.value?.total ?? 0) / (entries.value?.pageSize ?? 20))))

function syncForm(): void {
  form.libraryId = settings.value?.libraryId ?? bookLibraries.value[0]?.id ?? 0
  const library = bookLibraries.value.find((item) => item.id === form.libraryId)
  form.libraryFolderId = settings.value?.libraryFolderId ?? library?.folders[0]?.id ?? 0
  form.autoSync = settings.value?.autoSync ?? true
  form.intervalHours = settings.value?.intervalHours ?? 24
}

function handleLibraryChange(): void {
  form.libraryFolderId = selectedFolders.value[0]?.id ?? 0
}

function toggleTokenVisibility(): void {
  tokenVisible.value = !tokenVisible.value
}

async function handleSave(): Promise<void> {
  if (!form.libraryId || !form.libraryFolderId) {
    toast.error(t('yandexBooks.toast.chooseDestination'))
    return
  }
  const ok = await saveSettings({
    ...(token.value.trim() ? { apiToken: token.value.trim() } : {}),
    libraryId: form.libraryId,
    libraryFolderId: form.libraryFolderId,
    autoSync: form.autoSync,
    intervalHours: form.intervalHours,
  })
  if (!ok) {
    toast.error(error.value ?? t('yandexBooks.toast.saveFailed'))
    return
  }
  token.value = ''
  syncForm()
  toast.success(t('yandexBooks.toast.saved'))
}

async function handleUpdate(): Promise<void> {
  const ok = await startSync(false)
  if (!ok) toast.error(error.value ?? t('yandexBooks.toast.updateFailed'))
}

async function handleImportReady(): Promise<void> {
  const ok = await importEntries()
  if (ok) toast.success(t('yandexBooks.toast.importStarted'))
  else toast.error(error.value ?? t('yandexBooks.toast.importFailed'))
}

function handleOpenLink(entry: YandexBooksEntry): void {
  linkEntryId.value = entry.id
  linkedBook.value = null
}

function canLinkEntry(entry: YandexBooksEntry): boolean {
  return canImport.value && (!entry.bookId || hasPermission(Permission.LibraryDeleteBooks))
}

function handleCancelLink(): void {
  linkEntryId.value = null
  linkedBook.value = null
}

async function handleLinkEntry(): Promise<void> {
  if (!linkEntryId.value || !linkedBook.value) return
  linking.value = true
  try {
    const ok = await linkEntry(linkEntryId.value, linkedBook.value.id)
    if (ok) {
      handleCancelLink()
      toast.success(t('yandexBooks.toast.linked'))
    } else {
      toast.error(error.value ?? t('yandexBooks.toast.linkFailed'))
    }
  } finally {
    linking.value = false
  }
}

async function handleDisconnect(): Promise<void> {
  if (await disconnect()) toast.success(t('yandexBooks.toast.disconnected'))
  else toast.error(error.value ?? t('yandexBooks.toast.disconnectFailed'))
}

function handleStateChange(): void {
  void loadEntries(1, selectedState.value || undefined)
}

function handlePreviousPage(): void {
  const page = entries.value?.page ?? 1
  if (page > 1) void loadEntries(page - 1, selectedState.value || undefined)
}

function handleNextPage(): void {
  const page = entries.value?.page ?? 1
  if (page < totalPages.value) void loadEntries(page + 1, selectedState.value || undefined)
}

async function handleKeepLocal(entry: YandexBooksEntry): Promise<void> {
  const ok = await resolveEntry(entry.id, 'local')
  if (!ok) toast.error(error.value ?? t('yandexBooks.toast.resolveFailed'))
}

async function handleUseYandex(entry: YandexBooksEntry): Promise<void> {
  const ok = await resolveEntry(entry.id, 'remote')
  if (!ok) toast.error(error.value ?? t('yandexBooks.toast.resolveFailed'))
}

function mediaLabel(entry: YandexBooksEntry): string {
  return t(`yandexBooks.media.${entry.item.mediaKind}`)
}

function entryStatus(entry: YandexBooksEntry): string {
  return entry.item.remoteStatus || t('yandexBooks.entries.unknownStatus')
}

function progressLabel(entry: YandexBooksEntry): string | null {
  if (entry.item.percentage !== null) return `${Math.round(entry.item.percentage)}%`
  if (entry.item.positionSeconds !== null && entry.item.durationSeconds) {
    return `${Math.floor(entry.item.positionSeconds / 60)} / ${Math.floor(entry.item.durationSeconds / 60)} min`
  }
  return null
}

function syncedAtLabel(): string | null {
  if (!settings.value?.lastSyncedAt) return null
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(settings.value.lastSyncedAt))
}

function nextSyncLabel(): string | null {
  if (!settings.value?.nextSyncAt) return null
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(settings.value.nextSyncAt))
}

watch(
  () => settings.value,
  () => syncForm(),
)

onMounted(async () => {
  await Promise.all([loadSettings(), fetchLibraries()])
  syncForm()
  if (settings.value?.tokenConfigured) await loadEntries()
})

onUnmounted(stopPolling)
</script>

<template>
  <div class="space-y-6">
    <SettingsPageHeader v-if="!props.embedded" :title="t('settings.integrations.tabs.yandexBooks')" :subtitle="t('yandexBooks.settings.subtitle')" />

    <section class="space-y-5 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">{{ t('yandexBooks.connection.title') }}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ t('yandexBooks.connection.description') }}</p>
        </div>
        <span v-if="connected" class="flex shrink-0 items-center gap-1 text-xs text-primary">
          <CheckCircle2 class="size-3.5" />
          {{ t('yandexBooks.connection.connected') }}
        </span>
      </div>

      <div v-if="loading" class="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 class="size-3.5 animate-spin" />{{ t('yandexBooks.loading') }}
      </div>
      <div v-if="error" class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <AlertCircle class="mt-0.5 size-3.5 shrink-0" />
        <span>{{ error }}</span>
      </div>
      <div
        v-if="settings && !settings.encryptionConfigured"
        class="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      >
        {{ t('yandexBooks.connection.encryptionUnavailable') }}
      </div>
      <div v-if="settings?.needsReauth" class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {{ t('yandexBooks.connection.needsReauth') }}
      </div>

      <div class="space-y-2">
        <label for="yandex-books-token" class="text-xs font-medium uppercase tracking-wider text-muted-foreground">{{
          t('yandexBooks.connection.token')
        }}</label>
        <div class="flex gap-2">
          <input
            id="yandex-books-token"
            v-model="token"
            v-bind="SECRET_INPUT_ATTRS"
            type="text"
            :placeholder="t('yandexBooks.connection.tokenPlaceholder')"
            class="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            :class="{ 'input-secret': !tokenVisible }"
            :disabled="!canConfigure || !settings?.encryptionConfigured"
          />
          <Button variant="outline" size="sm" type="button" :disabled="!canConfigure" @click="toggleTokenVisibility">
            {{ tokenVisible ? t('yandexBooks.connection.hide') : t('yandexBooks.connection.show') }}
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">{{ t('yandexBooks.connection.tokenHint') }}</p>
        <p v-if="settings?.accountName || settings?.accountLogin" class="text-xs text-primary">
          {{ t('yandexBooks.connection.account', { name: settings.accountName ?? settings.accountLogin, login: settings.accountLogin ?? '' }) }}
        </p>
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <label class="space-y-1.5 text-sm">
          <span class="text-xs font-medium uppercase tracking-wider text-muted-foreground">{{ t('yandexBooks.destination.library') }}</span>
          <select
            v-model.number="form.libraryId"
            class="w-full rounded-md border border-border bg-background px-3 py-2"
            :disabled="!canConfigure"
            @change="handleLibraryChange"
          >
            <option :value="0" disabled>{{ t('yandexBooks.destination.selectLibrary') }}</option>
            <option v-for="library in bookLibraries" :key="library.id" :value="library.id">{{ library.name }}</option>
          </select>
        </label>
        <label class="space-y-1.5 text-sm">
          <span class="text-xs font-medium uppercase tracking-wider text-muted-foreground">{{ t('yandexBooks.destination.folder') }}</span>
          <select
            v-model.number="form.libraryFolderId"
            class="w-full rounded-md border border-border bg-background px-3 py-2"
            :disabled="!canConfigure || !selectedLibrary"
          >
            <option :value="0" disabled>{{ t('yandexBooks.destination.selectFolder') }}</option>
            <option v-for="folder in selectedFolders" :key="folder.id" :value="folder.id">{{ folder.path }}</option>
          </select>
        </label>
      </div>
      <p class="text-xs text-muted-foreground">{{ t('yandexBooks.destination.membersHint') }}</p>

      <div class="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <label class="space-y-1.5 text-sm">
          <span class="text-xs font-medium uppercase tracking-wider text-muted-foreground">{{ t('yandexBooks.schedule.interval') }}</span>
          <select
            v-model.number="form.intervalHours"
            class="w-full rounded-md border border-border bg-background px-3 py-2"
            :disabled="!canConfigure"
          >
            <option :value="6">{{ t('yandexBooks.schedule.everyHours', { count: 6 }) }}</option>
            <option :value="12">{{ t('yandexBooks.schedule.everyHours', { count: 12 }) }}</option>
            <option :value="24">{{ t('yandexBooks.schedule.everyHours', { count: 24 }) }}</option>
            <option :value="168">{{ t('yandexBooks.schedule.everyHours', { count: 168 }) }}</option>
          </select>
        </label>
        <label class="flex items-center gap-2 pb-2 text-sm">
          <input
            v-model="form.autoSync"
            type="checkbox"
            class="size-4 rounded border-border text-primary focus:ring-primary/40"
            :disabled="!canConfigure"
          />
          {{ t('yandexBooks.schedule.autoSync') }}
        </label>
      </div>

      <div class="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button type="button" size="sm" :disabled="saving || !canConfigure" @click="handleSave">
          <Loader2 v-if="saving" class="size-3.5 animate-spin" />
          <Save v-else class="size-3.5" />
          {{ t('yandexBooks.actions.save') }}
        </Button>
        <Button v-if="connected" type="button" variant="outline" size="sm" :disabled="saving" @click="handleDisconnect">
          <Unplug class="size-3.5" />
          {{ t('yandexBooks.actions.disconnect') }}
        </Button>
      </div>
    </section>

    <section v-if="connected" class="space-y-4 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="text-sm font-medium">{{ t('yandexBooks.sync.title') }}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ t('yandexBooks.sync.description') }}</p>
          <p v-if="syncedAtLabel()" class="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <Clock3 class="size-3" />{{ t('yandexBooks.sync.lastSynced', { date: syncedAtLabel() }) }}
          </p>
          <p v-if="nextSyncLabel() && settings?.autoSync" class="mt-1 text-xs text-muted-foreground">
            {{ t('yandexBooks.sync.nextSync', { date: nextSyncLabel() }) }}
          </p>
          <p v-if="settings?.lastError" class="mt-1 text-xs text-destructive">{{ settings.lastError }}</p>
        </div>
        <div class="flex gap-2">
          <Button type="button" variant="outline" size="sm" :disabled="syncing || !isConfigured || !canConfigure" @click="handleUpdate">
            <Loader2 v-if="syncing || settings?.syncing" class="size-3.5 animate-spin" />
            <RefreshCw v-else class="size-3.5" />
            {{ syncing || settings?.syncing ? t('yandexBooks.sync.updating') : t('yandexBooks.sync.update') }}
          </Button>
          <Button type="button" size="sm" :disabled="importing || importableCount === 0 || !canImport" @click="handleImportReady">
            <Loader2 v-if="importing" class="size-3.5 animate-spin" />
            <Download v-else class="size-3.5" />
            {{ t('yandexBooks.sync.importAll', { count: importableCount }) }}
          </Button>
        </div>
      </div>
      <p v-if="!hasPermission(Permission.LibraryUpload)" class="text-xs text-muted-foreground">
        {{ t('yandexBooks.sync.uploadPermissionRequired') }}
      </p>
      <div v-if="settings?.lastResult" class="grid grid-cols-2 gap-3 border-t border-border pt-3 text-xs sm:grid-cols-4">
        <span>{{ t('yandexBooks.sync.result.fetched', { count: settings.lastResult.fetched }) }}</span>
        <span>{{ t('yandexBooks.sync.result.imported', { count: settings.lastResult.imported }) }}</span>
        <span>{{ t('yandexBooks.sync.result.updated', { count: settings.lastResult.updated }) }}</span>
        <span>{{ t('yandexBooks.sync.result.conflicts', { count: settings.lastResult.conflicts }) }}</span>
      </div>
    </section>

    <section v-if="connected" class="space-y-4 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-sm font-medium">{{ t('yandexBooks.entries.title') }}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ t('yandexBooks.entries.description') }}</p>
        </div>
        <select v-model="selectedState" class="rounded-md border border-border bg-background px-2 py-1.5 text-xs" @change="handleStateChange">
          <option value="">{{ t('yandexBooks.entries.all') }}</option>
          <option value="ready">{{ t('yandexBooks.entries.ready') }}</option>
          <option value="conflict">{{ t('yandexBooks.entries.conflict') }}</option>
          <option value="imported">{{ t('yandexBooks.entries.imported') }}</option>
        </select>
      </div>

      <div v-if="!entries?.items.length" class="rounded-md border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
        {{ t('yandexBooks.entries.empty') }}
      </div>
      <div v-else class="divide-y divide-border rounded-md border border-border">
        <article v-for="entry in entries.items" :key="entry.id" class="space-y-2 px-3 py-3">
          <div class="flex min-w-0 items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">{{ entry.item.title }}</p>
              <p class="truncate text-xs text-muted-foreground">{{ entry.item.authors.join(', ') }}</p>
            </div>
            <a
              :href="entry.item.sourceUrl"
              target="_blank"
              rel="noopener"
              class="flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
            >
              {{ t('yandexBooks.entries.openYandex') }}<ExternalLink class="size-3" />
            </a>
          </div>
          <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{{ mediaLabel(entry) }}</span>
            <span>{{ t('yandexBooks.entries.status', { status: entryStatus(entry) }) }}</span>
            <span v-if="progressLabel(entry)">{{ t('yandexBooks.entries.progress', { value: progressLabel(entry) }) }}</span>
            <span v-if="entry.bookId" class="text-primary">{{ t('yandexBooks.entries.linked') }}</span>
          </div>
          <div v-if="canLinkEntry(entry)" class="flex items-center gap-2 text-xs">
            <Button variant="outline" size="sm" type="button" :disabled="linking" @click="handleOpenLink(entry)">
              {{ entry.bookId ? t('yandexBooks.entries.changeLink') : t('yandexBooks.entries.linkExisting') }}
            </Button>
          </div>
          <div v-if="linkEntryId === entry.id" class="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-2.5 py-2 text-xs">
            <YandexBooksBookPicker v-model="linkedBook" :library-id="form.libraryId" :exclude-book-id="entry.bookId" :disabled="linking" />
            <Button size="sm" type="button" :disabled="!linkedBook || linking" @click="handleLinkEntry">
              <Loader2 v-if="linking" class="size-3 animate-spin" />{{ t('yandexBooks.entries.link') }}
            </Button>
            <Button size="sm" variant="ghost" type="button" :disabled="linking" @click="handleCancelLink">{{
              t('yandexBooks.entries.cancel')
            }}</Button>
            <p v-if="entry.bookId" class="basis-full text-muted-foreground">{{ t('yandexBooks.entries.duplicateRepairHint') }}</p>
          </div>
          <div v-if="entry.state === 'conflict'" class="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-2.5 py-2 text-xs">
            <span class="min-w-0 flex-1 text-muted-foreground">{{ entry.conflict ?? t('yandexBooks.entries.conflictHint') }}</span>
            <Button size="sm" variant="outline" type="button" @click="handleKeepLocal(entry)">{{ t('yandexBooks.entries.keepLocal') }}</Button>
            <Button size="sm" type="button" @click="handleUseYandex(entry)">{{ t('yandexBooks.entries.useYandex') }}</Button>
          </div>
        </article>
      </div>
      <div v-if="entries && totalPages > 1" class="flex items-center justify-end gap-2 text-xs text-muted-foreground">
        <Button variant="outline" size="sm" type="button" :disabled="entries.page <= 1" @click="handlePreviousPage">{{
          t('yandexBooks.entries.previous')
        }}</Button>
        <span>{{ t('yandexBooks.entries.page', { page: entries.page, total: totalPages }) }}</span>
        <Button variant="outline" size="sm" type="button" :disabled="entries.page >= totalPages" @click="handleNextPage">{{
          t('yandexBooks.entries.next')
        }}</Button>
      </div>
    </section>
  </div>
</template>
