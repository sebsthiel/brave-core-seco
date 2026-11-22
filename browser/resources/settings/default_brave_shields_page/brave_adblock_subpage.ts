/* Copyright (c) 2022 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import './components/brave_adblock_editor.js'
import './components/brave_adblock_scriptlet_list.js'
import './components/brave_adblock_subscribe_dropdown.js'
import 'chrome://resources/cr_elements/cr_dialog/cr_dialog.js'
import 'chrome://resources/cr_elements/cr_textarea/cr_textarea.js'
import '//resources/cr_elements/md_select.css.js'

import {PrefService} from '/shared/settings/prefs2/pref_service.js'
import {PrefServiceObserverMixin} from '/shared/settings/prefs2/pref_service_observer_mixin.js'
import {I18nMixin} from 'chrome://resources/cr_elements/i18n_mixin.js'
import type {
  DomRepeatEvent
} from 'chrome://resources/polymer/v3_0/polymer/polymer_bundled.min.js'
import {
  PolymerElement
} from 'chrome://resources/polymer/v3_0/polymer/polymer_bundled.min.js'

import {BaseMixin} from '../base_mixin.js'

import {
  BraveAdblockBrowserProxy,
  BraveAdblockBrowserProxyImpl,
  CatalogAddon,
  CatalogScriptlet,
  ErrorCode,
  FilterList,
  PublishAddonError,
  Scriptlet,
  SubscriptionInfo
} from './brave_adblock_browser_proxy.js'

import {SettingsViewMixin} from '../settings_page/settings_view_mixin.js'

import {getTemplate} from './brave_adblock_subpage.html.js'

import {loadTimeData} from '../i18n_setup.js'

const DEVELOPER_MODE_PREF = 'brave.ad_block.developer_mode'

// Must match the category list in the catalog server's database.
const CATALOG_CATEGORIES =
  ['Ads', 'Annoyances', 'Cookie notices', 'Trackers', 'Other']

const CATALOG_PREVIEW_LIMIT = 3

// TODO: Store catalog preferences in Chromium prefs instead of localStorage.
const CATALOG_ENABLED_STORAGE_KEY = 'braveAddonCatalogEnabled'
const AUTHOR_NICKNAME_STORAGE_KEY = 'braveAddonAuthorNickname'
const INSTALLED_ADDONS_STORAGE_KEY = 'braveAddonInstalledAddons'
const PUBLISHED_ADDONS_STORAGE_KEY = 'braveAddonPublishedAddons'

const NICKNAME_ADJECTIVES =
  ['quiet', 'swift', 'brave', 'clever', 'gentle', 'sunny', 'calm', 'bold']
const NICKNAME_ANIMALS =
  ['otter', 'falcon', 'lynx', 'badger', 'heron', 'fox', 'panda', 'owl']

// Brave stores custom scriptlets as "user-<name>.js".
const SCRIPTLET_PREFIX = 'user-'
const SCRIPTLET_SUFFIX = '.js'

// Markers wrapping installed catalog add-on rules inside custom filters so
// they can be toggled or removed without touching the user's manual rules.
const ADDON_BLOCK_REGEX =
  /\n*! \[brave-addon:start \d+\][\s\S]*?! \[brave-addon:end \d+\]\n*/g

interface PublishRule {
  text: string
  selected: boolean
}

interface PublishScriptlet {
  name: string         // Stored name, e.g. "user-my-addon-fix.js".
  displayName: string  // Name without "user-" and ".js", e.g. "my-addon-fix".
  code: string
  selected: boolean
}

interface InstalledAddon {
  id: number
  title: string
  description: string
  author: string
  category: string
  filters: string
  scriptlets: CatalogScriptlet[]
  version: number
  addedAt: string
  enabled: boolean
  installedScriptletNames: string[]
}

interface PublishedAddonRecord {
  id: number
  title: string
  category: string
  author: string
  published_at: string
  updated_at: string
  downloads: number
  scriptlets: CatalogScriptlet[]
}

function getScriptletDisplayName(name: string) {
  let displayName = name
  if (displayName.toLowerCase().startsWith(SCRIPTLET_PREFIX)) {
    displayName = displayName.slice(SCRIPTLET_PREFIX.length)
  }
  if (displayName.toLowerCase().endsWith(SCRIPTLET_SUFFIX)) {
    displayName = displayName.slice(0, -SCRIPTLET_SUFFIX.length)
  }
  return displayName
}

// "Add-on A" -> "add-on-a". Scriptlet names must start with this plus "-".
function getTitleSlug(title: string) {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function countFilterRules(filters: string) {
  return (filters ?? '').split('\n')
    .filter(line => line.trim() && !line.trim().startsWith('!')).length
}

function stripManagedAddonBlocks(rawCustomFilters: string) {
  return (rawCustomFilters ?? '')
    .replace(ADDON_BLOCK_REGEX, '\n')
    .trim()
}

function composeCustomFilters(
  manualFilters: string, installedAddons: InstalledAddon[]) {
  const parts: string[] = []
  const trimmedManual = (manualFilters ?? '').trim()
  if (trimmedManual) {
    parts.push(trimmedManual)
  }
  for (const addon of installedAddons) {
    if (!addon.enabled) {
      continue
    }
    const rules = (addon.filters ?? '').trim()
    if (!rules) {
      continue
    }
    parts.push(
      `! [brave-addon:start ${addon.id}]\n` +
      `! Add-on: ${addon.title}\n` +
      `${rules}\n` +
      `! [brave-addon:end ${addon.id}]`)
  }
  return parts.join('\n\n')
}

function readStoredBoolean(key: string) {
  try {
    return window.localStorage.getItem(key) === 'true'
  } catch {
    return false
  }
}

function storeBoolean(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? 'true' : 'false')
  } catch {
    // Ignore storage errors.
  }
}

function readStoredNickname() {
  try {
    return window.localStorage.getItem(AUTHOR_NICKNAME_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function storeNickname(nickname: string) {
  try {
    window.localStorage.setItem(AUTHOR_NICKNAME_STORAGE_KEY, nickname)
  } catch {
    // Not remembering the nickname is fine.
  }
}

function readStoredJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return fallback
    }
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function storeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore storage errors.
  }
}

const AdBlockSubpageBase = SettingsViewMixin(
  PrefServiceObserverMixin(I18nMixin(BaseMixin(PolymerElement))))

class AdBlockSubpage extends AdBlockSubpageBase {
  static get is() {
    return 'adblock-subpage'
  }

  static get template() {
    return getTemplate()
  }

  static get properties() {
    return {
      filterList_: Array,
      subscriptionList_: Array,
      customFilters_: String,
      manualCustomFilters_: {
        type: String,
        value: ''
      },
      subscribeUrl_: String,
      listsUpdatingState_: String,
      hasListExpanded_: {
        type: Boolean,
        value: false
      },
      shouldShowCustomFilters_: Boolean,
      shouldShowCustomScriptlets_: Boolean,
      customScriptlets_: Array,
      developerModePref_: Object,
      catalogEnabled_: {
        type: Boolean,
        value: false
      },
      showCatalogDialog_: {
        type: Boolean,
        value: false
      },
      catalogAddons_: {
        type: Array,
        value: () => []
      },
      catalogLoadState_: {
        type: String,
        value: ''
      },
      catalogSearch_: {
        type: String,
        value: ''
      },
      catalogCategory_: {
        type: String,
        value: ''
      },
      catalogSort_: {
        type: String,
        value: 'downloads'
      },
      catalogExpanded_: {
        type: Boolean,
        value: false
      },
      selectedAddon_: {
        type: Object,
        value: null
      },
      showCodeViewer_: {
        type: Boolean,
        value: false
      },
      codeViewerTitle_: {
        type: String,
        value: ''
      },
      codeViewerContent_: {
        type: String,
        value: ''
      },
      installedAddons_: {
        type: Array,
        value: () => []
      },
      publishedAddons_: {
        type: Array,
        value: () => []
      },
      storedAuthorNickname_: {
        type: String,
        value: ''
      },
      downloadingAddonId_: {
        type: Number,
        value: 0
      },
      downloadSuccessMessage_: {
        type: String,
        value: ''
      },
      downloadErrorMessage_: {
        type: String,
        value: ''
      },
      deletingAddonId_: {
        type: Number,
        value: 0
      },
      deleteError_: {
        type: String,
        value: ''
      },
      scriptletAddonMap_: {
        type: Object,
        computed: 'computeScriptletAddonMap_(publishedAddons_, installedAddons_)'
      },
      showPublishForm_: {
        type: Boolean,
        value: false
      },
      publishTitle_: {
        type: String,
        value: ''
      },
      publishDescription_: {
        type: String,
        value: ''
      },
      publishCategory_: {
        type: String,
        value: 'Annoyances'
      },
      publishAuthor_: {
        type: String,
        value: ''
      },
      publishRules_: {
        type: Array,
        value: () => []
      },
      publishExtraFilters_: {
        type: String,
        value: ''
      },
      showPublishConfirm_: {
        type: Boolean,
        value: false
      },
      publishConfirmRuleCount_: {
        type: Number,
        value: 0
      },
      publishConfirmScriptletCount_: {
        type: Number,
        value: 0
      },
      publishScriptlets_: {
        type: Array,
        value: () => []
      },
      // '' (idle), 'publishing' or 'failed'.
      publishState_: {
        type: String,
        value: ''
      },
      publishError_: {
        type: String,
        value: ''
      },
      publishedTitle_: {
        type: String,
        value: ''
      },
      catalogCategories_: {
        type: Array,
        value: () => CATALOG_CATEGORIES
      }
    }
  }

  static get observers() {
    return [
      'updateState_(developerModePref_.value, manualCustomFilters_, customScriptlets_)'
    ]
  }

  private declare filterList_: FilterList[]
  private declare subscriptionList_: SubscriptionInfo[]
  private declare customFilters_: string
  private declare manualCustomFilters_: string
  private declare subscribeUrl_: string
  private declare listsUpdatingState_: string
  private declare hasListExpanded_: boolean
  private declare shouldShowCustomFilters_: boolean
  private declare shouldShowCustomScriptlets_: boolean
  private declare customScriptlets_: Scriptlet[]
  private declare developerModePref_: chrome.settingsPrivate.PrefObject<boolean>
  private declare catalogEnabled_: boolean
  private declare showCatalogDialog_: boolean
  private declare catalogAddons_: CatalogAddon[]
  // '' (not loaded), 'loading', 'loaded' or 'failed'.
  private declare catalogLoadState_: string
  private declare catalogSearch_: string
  private declare catalogCategory_: string
  private declare catalogSort_: string
  private declare catalogExpanded_: boolean
  private declare selectedAddon_: CatalogAddon|null
  private declare showCodeViewer_: boolean
  private declare codeViewerTitle_: string
  private declare codeViewerContent_: string
  private declare installedAddons_: InstalledAddon[]
  private declare publishedAddons_: PublishedAddonRecord[]
  private declare storedAuthorNickname_: string
  private declare downloadingAddonId_: number
  private declare downloadSuccessMessage_: string
  private declare downloadErrorMessage_: string
  private declare deletingAddonId_: number
  private declare deleteError_: string
  private declare scriptletAddonMap_: Record<string, string>
  private declare showPublishForm_: boolean
  private declare publishTitle_: string
  private declare publishDescription_: string
  private declare publishCategory_: string
  private declare publishAuthor_: string
  private declare publishRules_: PublishRule[]
  private declare publishExtraFilters_: string
  private declare showPublishConfirm_: boolean
  private declare publishConfirmRuleCount_: number
  private declare publishConfirmScriptletCount_: number
  private declare publishScriptlets_: PublishScriptlet[]
  private declare publishState_: string
  private declare publishError_: string
  private declare publishedTitle_: string
  private declare catalogCategories_: string[]

  private browserProxy_: BraveAdblockBrowserProxy =
    BraveAdblockBrowserProxyImpl.getInstance()

  override connectedCallback() {
    super.connectedCallback()

    this.mirrorPref(DEVELOPER_MODE_PREF, 'developerModePref_')
  }

  override ready() {
    super.ready()

    this.listsUpdatingState_ = ''
    this.storedAuthorNickname_ = readStoredNickname()
    this.installedAddons_ =
      readStoredJson<InstalledAddon[]>(INSTALLED_ADDONS_STORAGE_KEY, [])
    this.publishedAddons_ =
      readStoredJson<PublishedAddonRecord[]>(PUBLISHED_ADDONS_STORAGE_KEY, [])
    this.catalogEnabled_ = readStoredBoolean(CATALOG_ENABLED_STORAGE_KEY)

    if (this.catalogEnabled_) {
      this.loadCatalog_()
    }

    this.browserProxy_.getRegionalLists().then(value => {
      this.filterList_ = value
    })

    this.browserProxy_.getListSubscriptions().then(value => {
      this.subscriptionList_ = value
    })

    this.browserProxy_.getCustomFilters().then(value => {
      this.customFilters_ = value
      this.manualCustomFilters_ = stripManagedAddonBlocks(value)
    })

    this.browserProxy_.getCustomScriptlets().then((value: Scriptlet[]) => {
      this.customScriptlets_ = value
    })

    this.browserProxy_.addWebUiListener(
      'brave_adblock.onGetListSubscriptions', (value: SubscriptionInfo[]) => {
        this.subscriptionList_ = value
      })
    this.browserProxy_.addWebUiListener(
      'brave_adblock.onCustomFiltersChanged',
      (value: string) => {
        this.customFilters_ = value
        this.manualCustomFilters_ = stripManagedAddonBlocks(value)
      })
    this.browserProxy_.addWebUiListener(
      'brave_adblock.onCustomResourcesChanged',
      () => {
        this.browserProxy_.getCustomScriptlets().then((value: Scriptlet[]) => {
          this.customScriptlets_ = value
        })
      })
  }

  private updateState_(
    devMode: boolean,
    manualCustomFilters: string,
    customScriptlets: Scriptlet[]
  ) {
    this.shouldShowCustomScriptlets_ =
      devMode !== undefined &&
      customScriptlets !== undefined &&
      (customScriptlets.length > 0 || devMode)

    this.shouldShowCustomFilters_ =
      devMode !== undefined &&
      manualCustomFilters !== undefined &&
      (manualCustomFilters.trim().length > 0 || devMode)
  }

  private computeScriptletAddonMap_(
    publishedAddons: PublishedAddonRecord[],
    installedAddons: InstalledAddon[]
  ): Record<string, string> {
    const map: Record<string, string> = {}
    for (const addon of installedAddons ?? []) {
      for (const s of addon.scriptlets ?? []) {
        map[getScriptletDisplayName(s.name).toLowerCase()] = addon.title
      }
    }
    for (const addon of publishedAddons ?? []) {
      for (const s of addon.scriptlets ?? []) {
        map[getScriptletDisplayName(s.name).toLowerCase()] = addon.title
      }
    }
    return map
  }

  private handleTurnOnCatalog_() {
    this.showCatalogDialog_ = true
  }

  private handleCatalogDialogConfirm_() {
    this.catalogEnabled_ = true
    storeBoolean(CATALOG_ENABLED_STORAGE_KEY, true)
    this.showCatalogDialog_ = false
    this.loadCatalog_()
  }

  // Only called after the user has turned the catalog on, so nothing is sent
  // to the catalog server before that.
  private loadCatalog_() {
    this.catalogLoadState_ = 'loading'
    this.browserProxy_.getCatalogAddons().then(addons => {
      this.catalogAddons_ = addons
      this.catalogLoadState_ = 'loaded'
      // Keep the open detail view synced with fresh counts/dates.
      if (this.selectedAddon_) {
        const refreshed = addons.find(a => a.id === this.selectedAddon_!.id)
        if (refreshed) {
          this.selectedAddon_ = refreshed
        }
      }
    }, () => {
      this.catalogAddons_ = []
      this.catalogLoadState_ = 'failed'
    })
  }

  private handleCatalogDialogCancel_() {
    this.showCatalogDialog_ = false
  }

  private handleCatalogLearnMore_() {
    // TODO: Link to the add-on catalog help page.
  }

  // The toggle is only shown while the catalog is on, so it only turns it off.
  // Turning on always goes through the confirmation dialog.
  private handleCatalogToggle_(e: CustomEvent<{checked?: boolean}>) {
    const checked = Boolean(
      e.detail?.checked ?? (e as unknown as {checked?: boolean}).checked)
    if (!checked) {
      this.catalogEnabled_ = false
      storeBoolean(CATALOG_ENABLED_STORAGE_KEY, false)
      this.catalogAddons_ = []
      this.catalogLoadState_ = ''
      this.selectedAddon_ = null
      this.showPublishForm_ = false
    }
  }

  private getCatalogCategories_(addons: CatalogAddon[]) {
    return [...new Set(addons.map(addon => addon.category))].sort()
  }

  private filterCatalogAddons_(
    addons: CatalogAddon[], search: string, category: string, sort: string) {
    const query = search.trim().toLowerCase()
    const filtered = addons.filter(addon =>
      (!category || addon.category === category) &&
      (!query || [addon.title, addon.author, addon.category]
        .some(field => field.toLowerCase().includes(query))))

    const sorted = [...filtered]
    if (sort === 'newest') {
      sorted.sort((a, b) =>
        new Date(b.published_at).getTime() - new Date(a.published_at).getTime())
    } else if (sort === 'title') {
      sorted.sort((a, b) => a.title.localeCompare(b.title))
    } else {
      // Default: Most downloaded, tie-break alphabetically.
      sorted.sort((a, b) =>
        (b.downloads ?? 0) - (a.downloads ?? 0) ||
        a.title.localeCompare(b.title))
    }
    return sorted
  }

  private getVisibleCatalogAddons_(
    addons: CatalogAddon[], search: string, category: string, sort: string,
    expanded: boolean) {
    const filtered = this.filterCatalogAddons_(addons, search, category, sort)
    if (expanded || search.trim() || category) {
      return filtered
    }
    return filtered.slice(0, CATALOG_PREVIEW_LIMIT)
  }

  private shouldShowExpandCatalog_(
    addons: CatalogAddon[], search: string, category: string,
    expanded: boolean) {
    if (expanded || search.trim() || category) {
      return false
    }
    return addons.length > CATALOG_PREVIEW_LIMIT
  }

  private handleShowFullCatalog_() {
    this.catalogExpanded_ = true
  }

  private onCatalogSearchInput_(e: Event) {
    this.catalogSearch_ = (e.target as HTMLInputElement).value
  }

  private onCatalogCategoryChange_(e: Event) {
    this.catalogCategory_ = (e.target as HTMLSelectElement).value
  }

  private onCatalogSortChange_(e: Event) {
    this.catalogSort_ = (e.target as HTMLSelectElement).value
  }

  private getAddonContents_(addon: {filters: string, scriptlets: CatalogScriptlet[]}) {
    const rules = countFilterRules(addon.filters)
    const scriptlets = (addon.scriptlets ?? []).length
    const parts = []
    if (rules) {
      parts.push(`${rules} ${rules === 1 ? 'rule' : 'rules'}`)
    }
    if (scriptlets) {
      parts.push(`${scriptlets} ${scriptlets === 1 ? 'scriptlet' : 'scriptlets'}`)
    }
    return parts.join(', ')
  }

  private getAddonRuleCount_(addon: CatalogAddon|null) {
    return addon ? countFilterRules(addon.filters) : 0
  }

  private hasScriptlets_(addon: CatalogAddon|null) {
    return !!addon && (addon.scriptlets ?? []).length > 0
  }

  private formatAuthor_(author: string) {
    if (!author) {
      return ''
    }
    return author.startsWith('@') ? author : `@${author}`
  }

  private formatDownloads_(count?: number) {
    const value = count ?? 0
    if (value >= 1000) {
      return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
    }
    return String(value)
  }

  private formatCatalogDate_(isoDate: string) {
    const date = new Date(isoDate)
    return isNaN(date.getTime()) ? '' : date.toLocaleDateString()
  }

  private getScriptletDisplayName_(name: string) {
    return getScriptletDisplayName(name)
  }

  private addonNeedsDeveloperMode_(
    addon: {scriptlets: CatalogScriptlet[]}|null, devMode: boolean) {
    return !!addon && (addon.scriptlets ?? []).length > 0 && !devMode
  }

  private isOwnAddon_(
    addon: CatalogAddon|null, publishedAddons: PublishedAddonRecord[]) {
    return !!addon && publishedAddons.some(p => p.id === addon.id)
  }

  private isAddonInstalled_(
    addon: CatalogAddon|null, installedAddons: InstalledAddon[]) {
    return !!addon && installedAddons.some(i => i.id === addon.id)
  }

  private isAddonDownloading_(addon: CatalogAddon|null, downloadingId: number) {
    return !!addon && addon.id === downloadingId
  }

  private handleTurnOnDeveloperMode_(e: Event) {
    e.preventDefault()
    e.stopPropagation()
    PrefService.getInstance().setPrefValue(DEVELOPER_MODE_PREF, true)
  }

  private handleOpenAddonDetail_(e: DomRepeatEvent<CatalogAddon>) {
    this.downloadSuccessMessage_ = ''
    this.downloadErrorMessage_ = ''
    this.selectedAddon_ = e.model.item
  }

  private handleBackToCatalog_() {
    this.selectedAddon_ = null
    this.showCodeViewer_ = false
  }

  private handleViewRulesCode_(e: Event) {
    e.preventDefault()
    if (!this.selectedAddon_) {
      return
    }
    this.codeViewerTitle_ = `${this.selectedAddon_.title} — Filter rules`
    this.codeViewerContent_ = this.selectedAddon_.filters
    this.showCodeViewer_ = true
  }

  private handleViewScriptletCode_(e: DomRepeatEvent<CatalogScriptlet>) {
    e.preventDefault()
    const scriptlet = e.model.item
    this.codeViewerTitle_ = getScriptletDisplayName(scriptlet.name)
    this.codeViewerContent_ = scriptlet.code
    this.showCodeViewer_ = true
  }

  private handleCloseCodeViewer_() {
    this.showCodeViewer_ = false
  }

  private syncInstalledAddonFilters_(installedAddons: InstalledAddon[]) {
    const combined =
      composeCustomFilters(this.manualCustomFilters_, installedAddons)
    this.customFilters_ = combined
    this.browserProxy_.updateCustomFilters(combined)
  }

  private async installScriptlet_(
    name: string, code: string): Promise<string|null> {
    const candidates = [name]
    if (name.toLowerCase().endsWith(SCRIPTLET_SUFFIX)) {
      candidates.push(name.slice(0, -SCRIPTLET_SUFFIX.length))
    }
    for (const candidate of candidates) {
      const toAdd = new Scriptlet()
      toAdd.name = candidate
      toAdd.content = code
      const result = await this.browserProxy_.addCustomScriptlet(toAdd)
      if (result === ErrorCode.kOK) {
        return candidate
      }
      if (result === ErrorCode.kAlreadyExists) {
        const toUpdate = new Scriptlet()
        toUpdate.name = candidate
        toUpdate.content = code
        const updateResult =
          await this.browserProxy_.updateCustomScriptlet(candidate, toUpdate)
        if (updateResult === ErrorCode.kOK) {
          return candidate
        }
      }
    }
    return null
  }

  private async removeAddonScriptlets_(addon: InstalledAddon) {
    const targetDisplayNames = new Set(
      (addon.scriptlets ?? []).map(s => getScriptletDisplayName(s.name).toLowerCase()))
    const namesToRemove = new Set<string>(addon.installedScriptletNames ?? [])
    for (const existing of this.customScriptlets_ ?? []) {
      if (targetDisplayNames.has(
        getScriptletDisplayName(existing.name).toLowerCase())) {
        namesToRemove.add(existing.name)
      }
    }
    for (const name of namesToRemove) {
      await this.browserProxy_.removeCustomScriptlet(name)
    }
  }

  private handleDownloadAddon_(e: DomRepeatEvent<CatalogAddon>) {
    e.stopPropagation()
    this.downloadAddon_(e.model.item)
  }

  private handleDownloadSelectedAddon_() {
    if (this.selectedAddon_) {
      this.downloadAddon_(this.selectedAddon_)
    }
  }

  private async downloadAddon_(addon: CatalogAddon) {
    if (this.downloadingAddonId_ ||
        this.isOwnAddon_(addon, this.publishedAddons_) ||
        this.isAddonInstalled_(addon, this.installedAddons_) ||
        this.addonNeedsDeveloperMode_(addon, this.developerModePref_?.value)) {
      return
    }

    this.downloadingAddonId_ = addon.id
    this.downloadSuccessMessage_ = ''
    this.downloadErrorMessage_ = ''

    try {
      const installedScriptletNames: string[] = []
      for (const s of addon.scriptlets ?? []) {
        const storedName = await this.installScriptlet_(s.name, s.code)
        if (!storedName) {
          throw new Error(`Could not install scriptlet "${s.name}".`)
        }
        installedScriptletNames.push(storedName)
      }

      const installed: InstalledAddon = {
        id: addon.id,
        title: addon.title,
        description: addon.description,
        author: addon.author,
        category: addon.category,
        filters: addon.filters,
        scriptlets: addon.scriptlets ?? [],
        version: addon.version,
        addedAt: new Date().toISOString(),
        enabled: true,
        installedScriptletNames,
      }

      const nextInstalled = [
        installed,
        ...this.installedAddons_.filter(i => i.id !== addon.id),
      ]
      this.installedAddons_ = nextInstalled
      storeJson(INSTALLED_ADDONS_STORAGE_KEY, nextInstalled)
      this.syncInstalledAddonFilters_(nextInstalled)

      const rules = countFilterRules(addon.filters)
      const scriptlets = (addon.scriptlets ?? []).length
      if (rules && scriptlets) {
        this.downloadSuccessMessage_ =
          `Done. ${this.getCountLabel_(rules, 'rule', 'rules')} and ` +
          `${this.getCountLabel_(scriptlets, 'scriptlet', 'scriptlets')} ` +
          `were added to your filters and scriptlets.`
      } else if (rules) {
        this.downloadSuccessMessage_ =
          `Done. ${this.getCountLabel_(rules, 'rule', 'rules')} ` +
          `${rules === 1 ? 'was' : 'were'} added to your filters.`
      } else if (scriptlets) {
        this.downloadSuccessMessage_ =
          `Done. ${this.getCountLabel_(scriptlets, 'scriptlet', 'scriptlets')} ` +
          `${scriptlets === 1 ? 'was' : 'were'} added to your scriptlets.`
      }

      // Increment the server download counter (non-blocking if offline).
      this.browserProxy_.recordCatalogAddonDownload(addon.id).then(
        (downloads) => {
          this.catalogAddons_ = this.catalogAddons_.map(item =>
            item.id === addon.id ? {...item, downloads} : item)
          if (this.selectedAddon_ && this.selectedAddon_.id === addon.id) {
            this.selectedAddon_ = {...this.selectedAddon_, downloads}
          }
        }, () => {
          // Local install succeeded even if the counter request failed.
        })
    } catch (error) {
      this.downloadErrorMessage_ =
        error instanceof Error ? error.message : 'Failed to install add-on.'
    } finally {
      this.downloadingAddonId_ = 0
    }
  }

  private async handleInstalledAddonToggle_(
    e: DomRepeatEvent<InstalledAddon> & {detail?: {checked?: boolean}}) {
    const addon = e.model.item
    const nextEnabled = Boolean(
      e.detail?.checked ?? (e as unknown as {checked?: boolean}).checked)

    if (nextEnabled &&
        this.addonNeedsDeveloperMode_(addon, this.developerModePref_?.value)) {
      return
    }

    let installedScriptletNames = addon.installedScriptletNames ?? []
    if (addon.scriptlets?.length) {
      if (nextEnabled) {
        const addedNames: string[] = []
        for (const s of addon.scriptlets) {
          const storedName = await this.installScriptlet_(s.name, s.code)
          if (storedName) {
            addedNames.push(storedName)
          }
        }
        installedScriptletNames = addedNames
      } else {
        await this.removeAddonScriptlets_(addon)
        installedScriptletNames = []
      }
    }

    const nextInstalled = this.installedAddons_.map(item =>
      item.id === addon.id
        ? {...item, enabled: nextEnabled, installedScriptletNames}
        : item)
    this.installedAddons_ = nextInstalled
    storeJson(INSTALLED_ADDONS_STORAGE_KEY, nextInstalled)
    this.syncInstalledAddonFilters_(nextInstalled)
  }

  private async handleRemoveInstalledAddon_(e: DomRepeatEvent<InstalledAddon>) {
    const addon = e.model.item
    if (addon.scriptlets?.length) {
      await this.removeAddonScriptlets_(addon)
    }

    const nextInstalled = this.installedAddons_.filter(i => i.id !== addon.id)
    this.installedAddons_ = nextInstalled
    storeJson(INSTALLED_ADDONS_STORAGE_KEY, nextInstalled)
    this.syncInstalledAddonFilters_(nextInstalled)
  }

  private getMyAddons_(
    publishedAddons: PublishedAddonRecord[], catalogAddons: CatalogAddon[]) {
    const catalogById = new Map(catalogAddons.map(a => [a.id, a]))
    return publishedAddons.map(record => {
      const live = catalogById.get(record.id)
      return live ? {
        ...record,
        title: live.title,
        category: live.category,
        published_at: live.published_at,
        updated_at: live.updated_at,
        downloads: live.downloads,
      } : record
    })
  }

  private isDeletingAddon_(
    addon: PublishedAddonRecord, deletingAddonId: number) {
    return addon.id === deletingAddonId
  }

  private handleDeleteMyAddon_(e: DomRepeatEvent<PublishedAddonRecord>) {
    const addon = e.model.item
    if (this.deletingAddonId_ || !this.catalogEnabled_) {
      return
    }

    this.deletingAddonId_ = addon.id
    this.deleteError_ = ''
    this.browserProxy_.deleteCatalogAddon(addon.id).then(() => {
      const nextPublished =
        this.publishedAddons_.filter(item => item.id !== addon.id)
      this.publishedAddons_ = nextPublished
      storeJson(PUBLISHED_ADDONS_STORAGE_KEY, nextPublished)
      this.deletingAddonId_ = 0
      this.loadCatalog_()
    }, (error: PublishAddonError) => {
      this.deletingAddonId_ = 0
      if (error?.status === 404) {
        // Already gone on the server; remove locally.
        const nextPublished =
          this.publishedAddons_.filter(item => item.id !== addon.id)
        this.publishedAddons_ = nextPublished
        storeJson(PUBLISHED_ADDONS_STORAGE_KEY, nextPublished)
        this.loadCatalog_()
        return
      }
      this.deleteError_ = error?.error || 'Could not delete add-on.'
    })
  }

  private handlePublishAddon_() {
    // Every manual rule and scriptlet starts selected; the user unticks what
    // they don't want to share.
    this.publishRules_ = (this.manualCustomFilters_ ?? '').split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('!'))
      .map(text => ({text, selected: true}))
    this.publishScriptlets_ = (this.customScriptlets_ ?? []).map(s => ({
      name: s.name,
      displayName: getScriptletDisplayName(s.name),
      code: s.content,
      selected: true,
    }))
    this.publishTitle_ = ''
    this.publishDescription_ = ''
    this.publishCategory_ = 'Annoyances'
    this.publishAuthor_ = readStoredNickname()
    this.publishState_ = ''
    this.publishError_ = ''
    this.publishedTitle_ = ''
    this.publishExtraFilters_ = ''
    this.showPublishConfirm_ = false
    this.showPublishForm_ = true
  }

  private handlePublishCancel_() {
    this.showPublishForm_ = false
  }

  private handleSuggestNickname_() {
    const pick = (list: string[]) =>
      list[Math.floor(Math.random() * list.length)]
    const number = Math.floor(Math.random() * 90) + 10
    this.publishAuthor_ =
      `${pick(NICKNAME_ADJECTIVES)}-${pick(NICKNAME_ANIMALS)}-${number}`
  }

  private onPublishCategoryChange_(e: Event) {
    this.publishCategory_ = (e.target as HTMLSelectElement).value
  }

  private isPublishTitleTaken_(title: string, addons: CatalogAddon[]) {
    const normalized = title.trim().toLowerCase()
    return !!normalized &&
      addons.some(addon => addon.title.toLowerCase() === normalized)
  }

  private getTitleSlug_(title: string) {
    return getTitleSlug(title)
  }

  private isScriptletNameOk_(scriptlet: PublishScriptlet, title: string) {
    const slug = getTitleSlug(title)
    return !!slug &&
      /^[A-Za-z0-9_-]+$/.test(scriptlet.displayName) &&
      scriptlet.displayName.toLowerCase().startsWith(`${slug}-`)
  }

  private getScriptletNameError_(scriptlet: PublishScriptlet, title: string) {
    const slug = getTitleSlug(title)
    if (!slug) {
      return 'Enter a title to check this name.'
    }
    if (!/^[A-Za-z0-9_-]+$/.test(scriptlet.displayName)) {
      return 'Use only letters, numbers, "-" and "_". Rename it to publish.'
    }
    return `Name must start with "${slug}-". Rename it to publish.`
  }

  // Rules picked from custom filters plus the ones typed for this add-on,
  // without blank lines or "!" comments.
  private getSelectedRules_() {
    const extraRules = (this.publishExtraFilters_ ?? '').split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('!'))
    return [
      ...this.publishRules_.filter(rule => rule.selected).map(rule => rule.text),
      ...extraRules,
    ]
  }

  private getSelectedScriptlets_() {
    return this.publishScriptlets_.filter(scriptlet =>
      scriptlet.selected && this.isScriptletNameOk_(scriptlet, this.publishTitle_))
  }

  // The unused arguments make Polymer recompute when any of them change.
  private getSelectedRuleCount_(_rules: unknown) {
    return this.publishRules_.filter(rule => rule.selected).length
  }

  private getCountLabel_(count: number, singular: string, plural: string) {
    return `${count} ${count === 1 ? singular : plural}`
  }

  private canPublish_(
    title: string, author: string, category: string, _rules: unknown,
    _scriptlets: unknown, _extraFilters: string, addons: CatalogAddon[],
    state: string) {
    return !!title.trim() && !!author.trim() && !!category &&
      !this.isPublishTitleTaken_(title, addons) &&
      state !== 'publishing' &&
      (this.getSelectedRules_().length > 0 ||
       this.getSelectedScriptlets_().length > 0)
  }

  private getPublishConfirmLabel_(state: string) {
    return state === 'publishing' ? 'Publishing…' : 'Publish'
  }

  // Shows the confirmation dialog with what will be sent.
  private handlePublishContinue_() {
    this.publishConfirmRuleCount_ = this.getSelectedRules_().length
    this.publishConfirmScriptletCount_ = this.getSelectedScriptlets_().length
    this.publishError_ = ''
    this.publishState_ = ''
    this.showPublishConfirm_ = true
  }

  private handlePublishConfirmCancel_() {
    if (this.publishState_ === 'publishing') {
      return
    }
    this.showPublishConfirm_ = false
  }

  private handlePublishConfirm_() {
    const title = this.publishTitle_.trim()
    const author = this.publishAuthor_.trim()
    this.publishState_ = 'publishing'
    this.browserProxy_.publishCatalogAddon({
      title,
      author,
      description: this.publishDescription_.trim(),
      category: this.publishCategory_,
      filters: this.getSelectedRules_().join('\n'),
      scriptlets: this.getSelectedScriptlets_()
        .map(s => ({name: s.name, code: s.code})),
    }).then((createdAddon) => {
      storeNickname(author)
      this.storedAuthorNickname_ = author
      const record: PublishedAddonRecord = {
        id: createdAddon.id,
        title: createdAddon.title,
        category: createdAddon.category,
        author: createdAddon.author,
        published_at: createdAddon.published_at,
        updated_at: createdAddon.updated_at,
        downloads: createdAddon.downloads ?? 0,
        scriptlets: createdAddon.scriptlets ?? [],
      }
      const nextPublished = [
        record,
        ...this.publishedAddons_.filter(item => item.id !== record.id),
      ]
      this.publishedAddons_ = nextPublished
      storeJson(PUBLISHED_ADDONS_STORAGE_KEY, nextPublished)
      this.publishState_ = ''
      this.showPublishConfirm_ = false
      this.showPublishForm_ = false
      this.publishedTitle_ = title
      this.loadCatalog_()
    }, (error: PublishAddonError) => {
      // Back to the form, which shows the error.
      this.publishState_ = 'failed'
      this.publishError_ = error?.error || 'Publishing failed.'
      this.showPublishConfirm_ = false
    })
  }

  private handleShowList_() {
    if (!this.hasListExpanded_) {
      this.hasListExpanded_ = true
    }
  }

  private handleUpdateLists_() {
    if (this.listsUpdatingState_ === 'updating') {
      return
    }

    this.listsUpdatingState_ = 'updating'

    this.browserProxy_.updateFilterLists().then(() => {
      this.listsUpdatingState_ = 'updated'
    }, () => {
      this.listsUpdatingState_ = 'failed'
    })
  }

  private searchListBy_(title: string) {
    if (!title) {
      this.hasListExpanded_ = false
      return null
    }

    return (item: FilterList) => {
      this.hasListExpanded_ = true
      title = title.toLowerCase()
      return (item.title?.toLowerCase().includes(title) ||
              item.desc?.toLowerCase().includes(title))
    }
  }

  private handleFilterListItemToggle_(e: DomRepeatEvent<FilterList>) {
    const filterList = e.model.item
    this.browserProxy_.enableFilterList(filterList.uuid, filterList.enabled)
  }

  private handleSubscribeUrlItemItemToggle_(
    e: DomRepeatEvent<SubscriptionInfo>) {
    const subscriptionInfo = e.model.item
    this.browserProxy_.setSubscriptionEnabled(
      subscriptionInfo.subscription_url, subscriptionInfo.enabled)
  }

  private onKeyUp_(e: KeyboardEvent) {
    if (e.keyCode === 13) {
      this.handleSubmitUrl_()
    }
  }

  private handleSubmitUrl_() {
    const url = this.subscribeUrl_.trim()
    if (!url) return

    this.browserProxy_.addSubscription(url)
    this.subscribeUrl_ = ''
  }

  private handleSave_(e: CustomEvent) {
    const manualValue = e.detail.value
    this.manualCustomFilters_ = manualValue
    const combined = composeCustomFilters(manualValue, this.installedAddons_)
    this.customFilters_ = combined
    this.browserProxy_.updateCustomFilters(combined)
  }

  private handleUpdateSubscription_(
    e: Event&{model: {item: SubscriptionInfo}}) {
    this.browserProxy_.updateSubscription(e.model.item.subscription_url)
  }

  private handleDeleteSubscription_(
    e: Event&{model: {item: SubscriptionInfo}}) {
    this.browserProxy_.deleteSubscription(e.model.item.subscription_url)
  }

  private handleViewSubscription_(
    e: Event&{model: {item: SubscriptionInfo}}) {
    this.browserProxy_.viewSubscription(e.model.item.subscription_url)
  }

  private getStringHtml_(id: string, link: string) {
    return this.i18nAdvanced(id, { substitutions: [ link ]})
  }

  private isEqual_(lhs: unknown, rhs: unknown) {
    return lhs === rhs
  }

  private isFailedUpdate_(item: SubscriptionInfo) {
    return item.last_successful_update_attempt !== 0 &&
           item.last_successful_update_attempt !== item.last_update_attempt
  }

  private isLastAttemptFailed_(item: SubscriptionInfo) {
    return item.last_successful_update_attempt !== 0 &&
           item.last_successful_update_attempt === item.last_update_attempt
  }
}

customElements.define(AdBlockSubpage.is, AdBlockSubpage)