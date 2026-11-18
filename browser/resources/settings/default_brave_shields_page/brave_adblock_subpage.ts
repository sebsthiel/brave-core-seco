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
  FilterList,
  PublishAddonError,
  Scriptlet,
  SubscriptionInfo
} from './brave_adblock_browser_proxy.js'

import {SettingsViewMixin} from '../settings_page/settings_view_mixin.js';

import {getTemplate} from './brave_adblock_subpage.html.js'

import {loadTimeData} from '../i18n_setup.js'

const DEVELOPER_MODE_PREF = 'brave.ad_block.developer_mode'

// Must match the category list in the catalog server's database.
const CATALOG_CATEGORIES =
  ['Ads', 'Annoyances', 'Cookie notices', 'Trackers', 'Other']

// TODO: Store the nickname in a pref instead of localStorage.
const AUTHOR_NICKNAME_STORAGE_KEY = 'braveAddonAuthorNickname'

const NICKNAME_ADJECTIVES =
  ['quiet', 'swift', 'brave', 'clever', 'gentle', 'sunny', 'calm', 'bold']
const NICKNAME_ANIMALS =
  ['otter', 'falcon', 'lynx', 'badger', 'heron', 'fox', 'panda', 'owl']

// Brave stores custom scriptlets as "user-<name>.js".
const SCRIPTLET_PREFIX = 'user-'
const SCRIPTLET_SUFFIX = '.js'

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
      'updateState_(developerModePref_.value, customFilters_, customScriptlets_)'
    ]
  }

  private declare filterList_: FilterList[]
  private declare subscriptionList_: SubscriptionInfo[]
  private declare customFilters_: string
  private declare subscribeUrl_: string
  private declare listsUpdatingState_: string
  private declare hasListExpanded_: boolean
  private declare shouldShowCustomFilters_: boolean
  private declare shouldShowCustomScriptlets_: boolean
  private declare customScriptlets_: Scriptlet[]
  private declare developerModePref_: chrome.settingsPrivate.PrefObject<boolean>
  // TODO: Persist the catalog on/off state in a pref.
  private declare catalogEnabled_: boolean
  private declare showCatalogDialog_: boolean
  private declare catalogAddons_: CatalogAddon[]
  // '' (not loaded), 'loading', 'loaded' or 'failed'.
  private declare catalogLoadState_: string
  private declare catalogSearch_: string
  private declare catalogCategory_: string
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

    this.browserProxy_.getRegionalLists().then(value => {
      this.filterList_ = value
    })

    this.browserProxy_.getListSubscriptions().then(value => {
      this.subscriptionList_ = value
    })

    this.browserProxy_.getCustomFilters().then(value => {
      this.customFilters_ = value
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
      }
    )
    this.browserProxy_.addWebUiListener(
      'brave_adblock.onCustomResourcesChanged',
      () => {
        this.browserProxy_.getCustomScriptlets().then((value: Scriptlet[]) => {
          this.customScriptlets_ = value
        })
      },
    )
  }

  private updateState_(
    devMode: boolean,
    customFilters: string,
    customScriptlets: Scriptlet[]
  ) {
    this.shouldShowCustomScriptlets_ =
      devMode !== undefined &&
      customScriptlets !== undefined &&
      (customScriptlets.length > 0 || devMode)

    this.shouldShowCustomFilters_ =
      devMode !== undefined &&
      customFilters !== undefined &&
      (customFilters.trim().length > 0 || devMode)
  }

  private handleTurnOnCatalog_() {
    this.showCatalogDialog_ = true
  }

  private handleCatalogDialogConfirm_() {
    this.catalogEnabled_ = true
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
  private handleCatalogToggle_(detail: {checked: boolean}) {
    if (!detail.checked) {
      this.catalogEnabled_ = false
      this.catalogAddons_ = []
      this.catalogLoadState_ = ''
    }
  }

  private getCatalogCategories_(addons: CatalogAddon[]) {
    return [...new Set(addons.map(addon => addon.category))].sort()
  }

  private filterCatalogAddons_(
    addons: CatalogAddon[], search: string, category: string) {
    const query = search.trim().toLowerCase()
    return addons.filter(addon =>
      (!category || addon.category === category) &&
      (!query || [addon.title, addon.author, addon.category]
        .some(field => field.toLowerCase().includes(query))))
  }

  private onCatalogSearchInput_(e: Event) {
    this.catalogSearch_ = (e.target as HTMLInputElement).value
  }

  private onCatalogCategoryChange_(e: Event) {
    this.catalogCategory_ = (e.target as HTMLSelectElement).value
  }

  private getAddonContents_(addon: CatalogAddon) {
    // Count non-empty lines that aren't adblock comments ("!").
    const rules = addon.filters.split('\n')
      .filter(line => line.trim() && !line.trim().startsWith('!')).length
    const scriptlets = addon.scriptlets.length
    const parts = []
    if (rules) {
      parts.push(`${rules} ${rules === 1 ? 'rule' : 'rules'}`)
    }
    if (scriptlets) {
      parts.push(`${scriptlets} ${scriptlets === 1 ? 'scriptlet' : 'scriptlets'}`)
    }
    return parts.join(', ')
  }

  private formatCatalogDate_(isoDate: string) {
    const date = new Date(isoDate)
    return isNaN(date.getTime()) ? '' : date.toLocaleDateString()
  }

  private addonNeedsDeveloperMode_(addon: CatalogAddon, devMode: boolean) {
    return addon.scriptlets.length > 0 && !devMode
  }

  private handleTurnOnDeveloperMode_(e: Event) {
    e.preventDefault()
    PrefService.getInstance().setPrefValue(DEVELOPER_MODE_PREF, true)
  }

  private handleDownloadAddon_(e: Event&{model: {item: CatalogAddon}}) {
    // TODO: Download the add-on from the catalog database.
    console.log('Download add-on clicked', e.model.item.title)
  }

  private handlePublishAddon_() {
    // Every rule and scriptlet starts selected; the user unticks what they
    // don't want to share.
    this.publishRules_ = (this.customFilters_ ?? '').split('\n')
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
    }).then(() => {
      storeNickname(author)
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
    e: DomRepeatEvent<SubscriptionInfo>)
  {
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
    const value = e.detail.value
    this.browserProxy_.updateCustomFilters(value)
  }

  private handleUpdateSubscription_(
    e: Event&{model: {item: SubscriptionInfo}})
  {
    this.browserProxy_.updateSubscription(e.model.item.subscription_url)
  }

  private handleDeleteSubscription_(
    e: Event&{model: {item: SubscriptionInfo}})
  {
    this.browserProxy_.deleteSubscription(e.model.item.subscription_url)
  }

  private handleViewSubscription_(
    e: Event&{model: {item: SubscriptionInfo}})
  {
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
